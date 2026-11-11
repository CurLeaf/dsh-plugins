#!/usr/bin/env node
/**
 * Regenerates the file-type icon table in `lib/client.js`.
 *
 * The client half is loaded as one bundle (the web module loader has no
 * relative `require`), so the icons cannot live in their own module. This
 * script instead writes a marked block into `lib/client.js`:
 *
 *   /* @file-icons:start … *\/ … /* @file-icons:end *\/
 *
 * Source of truth is Material Icon Theme (MIT), pinned by version and
 * tarball integrity. Run `node scripts/build-file-icons.mjs` after editing
 * the catalog below; commit the resulting client.js block.
 *
 * The catalog is deliberately a subset: every icon becomes bytes in a bundle
 * that loads with the panel, and a file's icon is worth little more than the
 * ~120 common types below. Anything else falls back to the generic page.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const VERSION = '5.40.0'
const TARBALL = `https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-${VERSION}.tgz`
const INTEGRITY = 'sha512-IrvgusbwtqxhUtVgUy0nToJcfN7CYVRdbBxKMfbo0vab9flVBHA5INZ9UiE5SgRj+PM6opCl5nn5TZdpm2UaxA=='

/** Extensions that get their own icon; longest dotted suffix wins at runtime. */
const EXTENSIONS = `
	js mjs cjs jsx ts tsx mts cts vue svelte astro html htm xhtml
	css scss sass less styl stylus
	json json5 jsonc yaml yml toml ini cfg conf env properties xml plist
	md mdx markdown txt rst adoc org tex csv tsv sql graphql gql proto prisma ipynb log lock diff patch
	py pyi rb php go rs java kt kts scala groovy clj cljs ex exs erl hs ml fs fsx cs swift m mm dart lua pl pm r zig nim jl
	c h cc cpp cxx hpp hxx asm s wasm cu sol v vb fsi
	sh bash zsh fish ps1 bat cmd
	png jpg jpeg gif webp svg ico bmp avif tiff tif heic psd ai sketch fig eps
	mp4 mov mkv avi webm mp3 wav flac ogg m4a aac opus woff woff2 ttf otf eot
	zip tar gz tgz bz2 xz 7z rar zst jar exe dll so bin dmg pkg deb rpm apk ipa iso
	pdf doc docx xls xlsx ppt pptx odt ods odp epub rtf
	db sqlite sqlite3
`.split(/\s+/u).filter(Boolean)

/** Exact file names that beat their extension (`package.json` is a Node icon). */
const FILE_NAMES = `
	package.json package-lock.json pnpm-lock.yaml yarn.lock bun.lockb npm-shrinkwrap.json
	.gitignore .gitattributes .gitmodules .gitkeep .npmrc .nvmrc .node-version .editorconfig
	.prettierrc .prettierignore .eslintrc .eslintignore .babelrc .browserslistrc .dockerignore .stylelintrc
	Dockerfile docker-compose.yml docker-compose.yaml compose.yaml compose.yml
	Makefile makefile GNUmakefile CMakeLists.txt Rakefile Gemfile Gemfile.lock Cargo.toml Cargo.lock
	go.mod go.sum requirements.txt pyproject.toml setup.py setup.cfg Pipfile poetry.lock pom.xml
	build.gradle build.gradle.kts settings.gradle gradlew mvnw
	LICENSE LICENSE.md README.md README CHANGELOG.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
	tsconfig.json jsconfig.json vite.config.ts vite.config.js turbo.json nx.json lerna.json
	netlify.toml vercel.json firebase.json .env .env.local .env.example .env.development .env.production
	.ruby-version .python-version .babelrc.js .eslintrc.json .prettierrc.json
`.split(/\s+/u).filter(Boolean)

/**
 * Names Material Icon Theme has no entry for, or where the extension's icon
 * reads wrong. Everything else comes from the theme's own manifest.
 */
const ALIASES = {
	'Gemfile.lock': 'lock',
	'Cargo.lock': 'lock',
	'Cargo.toml': 'rust',
	'build.gradle': 'gradle',
	'build.gradle.kts': 'gradle',
	'settings.gradle': 'gradle',
	'setup.py': 'python',
	'setup.cfg': 'python-misc',
	'vite.config.ts': 'vite',
	'vite.config.js': 'vite',
	'compose.yaml': 'docker',
	'compose.yml': 'docker',
	'docker-compose.yaml': 'docker',
	'.env': 'tune',
	'.env.example': 'tune',
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const clientPath = join(packageRoot, 'lib', 'client.js')
const cacheRoot = join(packageRoot, '.cache', `material-icon-theme-${VERSION}`)
const themeRoot = join(cacheRoot, 'package')

/** One icon's inner markup, with gradient ids namespaced per icon. */
function readIcon(name) {
	const file = join(themeRoot, 'icons', `${name}.svg`)
	const raw = readFileSync(file, 'utf8')
	const viewBox = /viewBox="([^"]+)"/u.exec(raw)?.[1] ?? '0 0 24 24'
	let inner = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')).replace(/\s+/gu, ' ').trim()
	for (const id of [...inner.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1])) {
		inner = inner.split(`id="${id}"`).join(`id="${name}-${id}"`)
		inner = inner.split(`url(#${id})`).join(`url(#${name}-${id})`)
		inner = inner.split(`href="#${id}"`).join(`href="#${name}-${id}"`)
	}
	return [viewBox, inner]
}

async function download() {
	if (existsSync(join(themeRoot, 'dist', 'material-icons.json'))) return
	await mkdir(cacheRoot, { recursive: true })
	const tarball = join(cacheRoot, 'theme.tgz')
	await run('curl', ['-fL', '--retry', '3', '-o', tarball, TARBALL])
	const digest = createHash('sha512').update(await readFile(tarball)).digest('base64')
	if (`sha512-${digest}` !== INTEGRITY) throw new Error(`material-icon-theme tarball integrity mismatch: ${digest}`)
	await run('tar', ['-xzf', tarball, '-C', cacheRoot])
	await rm(tarball)
}

function renderBlock(svgs, byExtension, byName) {
	const indent = '\t\t'
	const line = (name, value) => `${indent}\t${JSON.stringify(name)}: ${JSON.stringify(value)},`
	const svgLines = Object.keys(svgs)
		.sort()
		.map((name) => line(name, svgs[name]))
	const extensionLines = Object.keys(byExtension)
		.sort()
		.map((key) => line(key, byExtension[key]))
	const nameLines = Object.keys(byName)
		.sort()
		.map((key) => line(key, byName[key]))
	return [
		`${indent}/* @file-icons:start — generated by scripts/build-file-icons.mjs from`,
		`${indent}   Material Icon Theme ${VERSION} (MIT); regenerate instead of editing. */`,
		`${indent}const FILE_ICON_SVGS = {`,
		...svgLines,
		`${indent}}`,
		`${indent}const FILE_ICON_BY_EXTENSION = {`,
		...extensionLines,
		`${indent}}`,
		`${indent}const FILE_ICON_BY_NAME = {`,
		...nameLines,
		`${indent}}`,
		`${indent}/* @file-icons:end */`,
	].join('\n')
}

async function main() {
	await download()
	const manifest = JSON.parse(await readFile(join(themeRoot, 'dist', 'material-icons.json'), 'utf8'))
	const extensionTable = Object.fromEntries(Object.entries(manifest.fileExtensions).map(([key, value]) => [key.toLowerCase(), value]))
	const nameTable = Object.fromEntries(Object.entries(manifest.fileNames).map(([key, value]) => [key.toLowerCase(), value]))

	const byExtension = {}
	for (const extension of EXTENSIONS) {
		const icon = extensionTable[extension]
		if (icon !== undefined) byExtension[extension] = icon
	}
	const byName = {}
	for (const name of FILE_NAMES) {
		const icon = ALIASES[name] ?? nameTable[name.toLowerCase()]
		if (icon !== undefined) byName[name.toLowerCase()] = icon
	}

	const iconNames = new Set([...Object.values(byExtension), ...Object.values(byName), 'file'])
	const svgs = {}
	for (const name of iconNames) {
		if (existsSync(join(themeRoot, 'icons', `${name}.svg`))) svgs[name] = readIcon(name)
	}

	const client = await readFile(clientPath, 'utf8')
	const start = client.indexOf('\t\t/* @file-icons:start')
	const end = client.indexOf('\t\t/* @file-icons:end */')
	if (start === -1 || end === -1) throw new Error('lib/client.js has no @file-icons markers')
	const next = `${client.slice(0, start)}${renderBlock(svgs, byExtension, byName)}${client.slice(end + '\t\t/* @file-icons:end */'.length)}`
	await writeFile(clientPath, next)
	const bytes = Buffer.byteLength(next) - Buffer.byteLength(client)
	console.log(`file icons: ${Object.keys(svgs).length} icons, ${Object.keys(byExtension).length} extensions, ${Object.keys(byName).length} names (+${(bytes / 1024).toFixed(1)} KB)`)
}

await main()
