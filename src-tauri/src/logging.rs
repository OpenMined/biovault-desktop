use chrono::Local;
#[cfg(unix)]
use libc::{STDERR_FILENO, STDOUT_FILENO};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::fd::{FromRawFd, RawFd};
use std::path::PathBuf;
use std::sync::Once;
use std::thread;

/// Represents the type of log event being recorded.
#[derive(Clone, Copy)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}

/// Resolve the fully-qualified path to the desktop log file.
pub fn desktop_log_path() -> PathBuf {
    let mut path = crate::resolve_biovault_home_path();
    path.push("logs");
    path.push("desktop.log");
    path
}

fn write_log_line(level: LogLevel, message: &str) -> io::Result<()> {
    let timestamp = Local::now().format("%Y-%m-%dT%H:%M:%S%:z");
    let log_line = format!("[{}][{}] {}\n", timestamp, level.as_str(), message);

    let log_path = desktop_log_path();
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;

    file.write_all(log_line.as_bytes())?;
    Ok(())
}

/// Append a timestamped log entry to the desktop log file.
pub fn log_desktop_event(level: LogLevel, message: &str) {
    let _ = write_log_line(level, message);
}

#[cfg(unix)]
fn pipe_wrap() -> io::Result<(RawFd, RawFd)> {
    let mut fds = [0; 2];
    let res = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if res == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok((fds[0], fds[1]))
    }
}

#[cfg(unix)]
fn dup_wrap(fd: RawFd) -> io::Result<RawFd> {
    let res = unsafe { libc::dup(fd) };
    if res == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(res)
    }
}

#[cfg(unix)]
fn dup2_wrap(src: RawFd, dst: RawFd) -> io::Result<()> {
    let res = unsafe { libc::dup2(src, dst) };
    if res == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn close_wrap(fd: RawFd) -> io::Result<()> {
    let res = unsafe { libc::close(fd) };
    if res == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn redirect_stream_to_log(fd: RawFd, level: LogLevel, label: &'static str) -> io::Result<()> {
    let (read_fd, write_fd) = pipe_wrap()?;
    let original_fd = dup_wrap(fd)?;

    dup2_wrap(write_fd, fd)?;
    close_wrap(write_fd)?;

    thread::spawn(move || {
        let mut reader = match unsafe { file_from_descriptor(read_fd) } {
            Ok(file) => file,
            Err(err) => {
                let _ = write_log_line(
                    LogLevel::Error,
                    &format!("Failed to open pipe reader for {}: {}", label, err),
                );
                return;
            }
        };

        let mut original = match unsafe { file_from_descriptor(original_fd) } {
            Ok(file) => file,
            Err(err) => {
                let _ = write_log_line(
                    LogLevel::Error,
                    &format!("Failed to open duplicated stream for {}: {}", label, err),
                );
                return;
            }
        };
        let mut buffer = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    break;
                }
                Ok(n) => {
                    let chunk = &buffer[..n];
                    let _ = original.write_all(chunk);
                    let _ = original.flush();
                    pending.extend_from_slice(chunk);

                    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                        let mut line = pending.drain(..=pos).collect::<Vec<u8>>();
                        if let Some(b'\n') = line.last() {
                            line.pop();
                        }
                        if let Some(b'\r') = line.last() {
                            line.pop();
                        }
                        let message = String::from_utf8_lossy(&line);
                        log_desktop_event(level, &format!("[{}] {}", label, message));
                    }
                }
                Err(err) => {
                    if err.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    break;
                }
            }
        }

        if !pending.is_empty() {
            let message = String::from_utf8_lossy(&pending);
            log_desktop_event(level, &format!("[{}] {}", label, message));
        }
    });

    Ok(())
}

/// Initialise stdout/stderr redirection so bundled apps still capture logs.
#[cfg(unix)]
pub fn init_stdio_forwarding() {
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        if let Err(err) = redirect_stream_to_log(STDOUT_FILENO, LogLevel::Info, "STDOUT") {
            let _ = write_log_line(
                LogLevel::Error,
                &format!("Failed to redirect STDOUT to desktop log: {}", err),
            );
        }

        if let Err(err) = redirect_stream_to_log(STDERR_FILENO, LogLevel::Error, "STDERR") {
            let _ = write_log_line(
                LogLevel::Error,
                &format!("Failed to redirect STDERR to desktop log: {}", err),
            );
        }

        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
                .unwrap_or_else(|| "unknown".to_string());
            log_desktop_event(
                LogLevel::Error,
                &format!("Panic encountered at {}: {}", location, info),
            );
            previous_hook(info);
        }));
    });
}

#[cfg(unix)]
unsafe fn file_from_descriptor(fd: RawFd) -> io::Result<File> {
    Ok(File::from_raw_fd(fd))
}

#[cfg(not(unix))]
pub fn init_stdio_forwarding() {}

#[macro_export]
macro_rules! desktop_log {
    ($($arg:tt)*) => {{
        $crate::logging::log_desktop_event($crate::logging::LogLevel::Info, &format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! desktop_warn {
    ($($arg:tt)*) => {{
        $crate::logging::log_desktop_event($crate::logging::LogLevel::Warn, &format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! desktop_error {
    ($($arg:tt)*) => {{
        $crate::logging::log_desktop_event($crate::logging::LogLevel::Error, &format!($($arg)*));
    }};
}
