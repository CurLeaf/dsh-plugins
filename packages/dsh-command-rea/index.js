import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/**
 * `/rea <target or question>` — hand one reverse-engineering request to the
 * agent as an ordinary user message that asks for the
 * `reverse-engineer-anything` skill and its REA MCP tools. The command result
 * itself stays out of model history, like every other slash command.
 *
 * The plugin imports nothing from `@deepseek-ai/*` on purpose: a `link:` install
 * is evaluated from its checkout, outside the profile directory, where the
 * launcher's bare-specifier routing does not apply. Every framework value this
 * command needs is therefore mirrored below, so it loads the same way from a
 * checkout and from a published package.
 */
export const name = 'command-rea'
export const inject = ['commands']

/** Stable definition identity, the runtime value of `CommandDefinitionId(id)`. */
const DEFINITION_ID = 'dsh-command-rea'

const USAGE = '用法：/rea <目标路径或问题>'

/** The skill that owns the REA workflow, named exactly as in its catalog. */
const SKILL = 'reverse-engineer-anything'

/** Deep-freeze one value in place, the way a published message is frozen. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

/**
 * Same message the framework's `createUserMessage()` publishes: a detached
 * clone with a fresh identity, the fixed `user` role and an ordinary user
 * source, deep-frozen before it reaches the agent.
 * @param {{ content: readonly object[], source: { kind: 'user' } }} input - content and producer source.
 * @returns {object} an immutable user message.
 */
function createUserMessage(input) {
  return deepFreeze(structuredClone({
    ...input,
    id: randomUUID(),
    role: 'user',
  }))
}

/**
 * The prompt one invocation injects: plain user text with the task last, so
 * the turn reads in history like any other human request.
 * @param {string} task - the trimmed request.
 * @param {number} attachmentCount - admitted composer attachments.
 * @returns {string} the model-facing prompt.
 */
function composePrompt(task, attachmentCount) {
  const lines = [
    `请加载 ${SKILL} 技能，并按它的流程用 REA 完成下面的任务。`,
    '',
    `任务：${task}`,
  ]
  if (attachmentCount > 0) {
    lines.push('', `任务目标见随附的 ${attachmentCount} 个附件。`)
  }
  return lines.join('\n')
}

/**
 * Whether the running host carries the menu-face patch this package bundles.
 *
 * The host process is `.../@deepseek-ai/dsh/lib/bin.js`, so the client bundle it
 * serves sits two levels up. Anything unexpected answers `undefined` and the
 * caller stays quiet.
 * @returns `'patched'`, `'unpatched'`, or `undefined` when the layout is unknown.
 */
function menuFacePatchState() {
  try {
    const entry = process.argv[1]
    if (typeof entry !== 'string' || !entry.endsWith(`${sep}lib${sep}bin.js`)) return undefined
    const client = join(
      dirname(dirname(entry)),
      'node_modules',
      '@deepseek-ai',
      'dsh-client-ui-commands',
      'lib',
      'client.js',
    )
    return readFileSync(client, 'utf8').includes('function declaredRowFace') ? 'patched' : 'unpatched'
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  if (menuFacePatchState() === 'unpatched') {
    console.warn(
      '[dsh-command-rea] /rea has no menu face yet: run `dsh-command-rea-patch` (or `npx dsh-command-rea-patch`) once, then restart the web host.',
    )
  }
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: DEFINITION_ID,
      name: 'rea',
      // Menu face the client renders instead of the bare command name: the
      // title becomes the row, the icon is a shared primitives export name.
      title: '逆向分析',
      icon: 'IconInspectOutlineRegular',
      description: '用 REA 逆向分析目标',
      // Free-form request, optionally accompanied by the targets it names.
      input: { hint: '<目标路径或问题>', attachments: true },
      handler: ({ agent, rawInput, attachments }) => {
        const task = rawInput.trim()
        if (task.length === 0) return { kind: 'error', text: USAGE }

        // One identified, frozen user message published through followup(), the
        // same injection other commands use; the command itself never becomes
        // a model message.
        agent.followup(createUserMessage({
          content: [
            ...attachments,
            { type: 'text', text: composePrompt(task, attachments.length) },
          ],
          source: { kind: 'user' },
        }))

        return { kind: 'success', text: `已交给 REA：${task}` }
      },
    })
  }, 'command-rea lifecycle')
}
