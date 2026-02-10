# SeQure Bug Notes

## Summary

This issue is not caused by the live server itself or by `tcp_preflight data_sharing ... CONNECT_FAIL` (that check is diagnostic only and does not block launch).  
The strongest signal is a binary/path split:

- Runs using the app-bundled SeQure binary fail around ~20s with `signal: 9` (`kill_reason=external_or_unknown`).
- Runs using the local release SeQure binary complete successfully (~250s, exit code `0`).

Build-path mismatch that supports this:

- App packaging scripts currently copy `syqure/target/debug/syqure` into app resources (`build.sh`, `build-go.sh`, `build-signed.sh`, `build-go-signed.sh`).
- App binary `LC_RPATH` includes a debug build path (`.../target/debug/build/syqure-*/out/bundle/lib/codon`), while local working binary points at release build output.

## Good Path (works)

- Binary:
  - `/Users/madhavajay/dev/biovault-desktop/workspace9/syqure/target/release/syqure`
- Example successful run logs (`70c34cb6-048c-46aa-af3b-eaffbd477899`):
  - `/Users/madhavajay/dev/biovaults-live-test/me@madhavajay.com/datasites/.syqure-cache/70c34cb6-048c-46aa-af3b-eaffbd477899/party-1/syqure-native.log`
  - `/Users/madhavajay/dev/biovaults-live-test/madhava@openmined.org/datasites/.syqure-cache/70c34cb6-048c-46aa-af3b-eaffbd477899/party-0/syqure-native.log`
  - `/Users/madhavajay/dev/biovaults-live-test/test@madhavajay.com/datasites/.syqure-cache/70c34cb6-048c-46aa-af3b-eaffbd477899/party-2/syqure-native.log`

## Bad Path (fails with SIGKILL 9)

- Binary:
  - `/Applications/BioVault.app/Contents/Resources/resources/syqure/syqure`
- Example failing run logs (`3e8a1928-614d-4ce3-950f-db3f694ac61c`):
  - `/Users/madhavajay/dev/biovaults-live-test/me@madhavajay.com/datasites/.syqure-cache/3e8a1928-614d-4ce3-950f-db3f694ac61c/party-1/syqure-native.log`
  - `/Users/madhavajay/dev/biovaults-live-test/madhava@openmined.org/datasites/.syqure-cache/3e8a1928-614d-4ce3-950f-db3f694ac61c/party-0/syqure-native.log`
  - `/Users/madhavajay/dev/biovaults-live-test/test@madhavajay.com/datasites/.syqure-cache/3e8a1928-614d-4ce3-950f-db3f694ac61c/party-2/syqure-native.log`

## Practical Next Step

Force desktop runs to use the known-good local release binary:

- `SEQURE_NATIVE_BIN=/Users/madhavajay/dev/biovault-desktop/workspace9/syqure/target/release/syqure`

## Fast SIGKILL Probe (No UI / No Live Server)

Use this lightweight probe from `workspace9`:

```bash
/bin/zsh -lc '
cd /Users/madhavajay/dev/biovault-desktop/workspace9/syqure
for b in \
  "/Users/madhavajay/dev/biovault-desktop/workspace9/syqure/target/release/syqure" \
  "/Applications/BioVault.app/Contents/Resources/resources/syqure/syqure"
do
  echo "=== $b"
  log="/tmp/probe_supervised_$(basename "$b").log"
  : > "$log"
  OMP_NUM_THREADS=1 "$b" example/simple_add.codon > "$log" 2>&1 &
  pid=$!
  exited=0
  for i in {1..25}; do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"; rc=$?
      echo "self_exit_after=${i}s rc=$rc"
      exited=1
      break
    fi
  done
  if [[ "$exited" -eq 0 ]]; then
    echo "alive_after_25s -> sending TERM"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "still_alive_after_TERM -> sending KILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi
  echo "log_tail:"
  tail -n 30 "$log"
  echo
done
'
```

Observed result on this machine:

- Local release binary: alive after 25s (no spontaneous SIGKILL).
- App-bundled binary: `self_exit_after=16s rc=137` (signal 9).

This gives a quick binary-level crash signature before running full multiparty UI flows.
