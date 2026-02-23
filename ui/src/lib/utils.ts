import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

const avatarTonePalette = [
	'bg-rose-100 text-rose-700',
	'bg-orange-100 text-orange-700',
	'bg-amber-100 text-amber-700',
	'bg-lime-100 text-lime-700',
	'bg-emerald-100 text-emerald-700',
	'bg-teal-100 text-teal-700',
	'bg-cyan-100 text-cyan-700',
	'bg-sky-100 text-sky-700',
	'bg-blue-100 text-blue-700',
	'bg-indigo-100 text-indigo-700',
	'bg-violet-100 text-violet-700',
	'bg-fuchsia-100 text-fuchsia-700',
] as const

export function getAvatarToneClass(seed: string): string {
	if (!seed) return 'bg-muted text-muted-foreground'
	if (seed.startsWith('guest:')) return 'bg-slate-200 text-slate-700'
	let hash = 0
	for (let i = 0; i < seed.length; i += 1) {
		hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	}
	return avatarTonePalette[hash % avatarTonePalette.length]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null }
