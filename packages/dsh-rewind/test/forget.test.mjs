/**
 * Behaviour tests for the context half of a rewind.
 *
 * The Host admits a surface rewrite outside an open turn in exactly one shape:
 * a compaction checkpoint transaction. These tests pin that shape, because a
 * wrong one does not fail loudly at the append — it fails later, when the log
 * is persisted or replayed, and it takes the session tail with it.
 *
 * `surfaceSeqs` and `planForget` are pure, so they run without a Host. The
 * append sequence is checked against a recording session stub; the companion
 * verification against the real `@deepseek-ai/dsh-session` validator lives in
 * the README's "Mechanism" section, because it needs the installed app.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { forgetIn, planForget, surfaceSeqs } from '../lib/index.js'

/** One turn: user text, assistant text, closed. */
function turnEvents(turn, seq, text) {
	return [
		{ type: 'turn/start', seq: seq + 0, data: { turn } },
		{ type: 'step/start', seq: seq + 1, data: { turn, step: 1 } },
		{ type: 'user/message', seq: seq + 2, data: { content: [{ type: 'text', text }] } },
		{ type: 'assistant/message', seq: seq + 3, data: { content: [{ type: 'text', text: `ok ${text}` }] } },
		{ type: 'step/end', seq: seq + 4, data: { turn, step: 1 } },
		{ type: 'turn/end', seq: seq + 5, data: { turn } },
	]
}

/** Three closed turns, contiguous from seq 0. */
function threeTurns() {
	return [
		...turnEvents(1, 0, 'first'),
		...turnEvents(2, 6, 'second'),
		...turnEvents(3, 12, 'third'),
	]
}

/** A session stub that records appends and returns synthetic events. */
function recordingSession(events) {
	const appended = []
	return {
		appended,
		snapshotEvents: () => events,
		append(type, data, options) {
			const seq = events.length + appended.length
			const event = { type, seq, data, ...(options ?? {}) }
			appended.push(event)
			return event
		},
	}
}

test('surfaceSeqs folds appends and replacements into model-visible order', () => {
	const events = [
		{ type: 'system/message', seq: 0, data: {} },
		{ type: 'user/message', seq: 1, data: {} },
		{ type: 'assistant/message', seq: 2, data: {} },
		// replace [1,2] with 3
		{ type: 'user/message', seq: 3, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, data: {} },
		{ type: 'turn/start', seq: 4, data: { turn: 2 } },
		{ type: 'user/message', seq: 5, surfaceOp: 'append', data: {} },
	]
	assert.deepEqual(surfaceSeqs(events), [0, 3, 5])
})

test('planForget names the whole tail of the surface, not a seq range', () => {
	// Turn 2's user message (seq 8) was replaced earlier by a node appended at
	// seq 18, and turn 4 closed afterwards. Surface order is therefore
	// [2, 3, 18, 9, 14, 15, 21, 22]: a raw `seq >= turn/start` filter would
	// yield [9, 14, 15, 18, 21, 22], which names no valid replacement span.
	const events = [
		...threeTurns(),
		{ type: 'user/message', seq: 18, surfaceOp: { op: 'replace', startSeq: 8, endSeq: 8 }, data: {} },
		...turnEvents(4, 19, 'fourth'),
	]
	assert.deepEqual(surfaceSeqs(events), [2, 3, 18, 9, 14, 15, 21, 22])

	const plan = planForget(events, 2)
	assert.equal(plan.reason, undefined)
	assert.deepEqual(plan.shadowedSeqs, [18, 9, 14, 15, 21, 22])
	assert.equal(plan.startSeq, 18)
	assert.equal(plan.endSeq, 22)
	assert.match(plan.note, /reverted turn 2/)
})

test('planForget refuses an open turn, an unknown turn and an empty tail', () => {
	assert.equal(planForget([{ type: 'turn/start', seq: 0, data: { turn: 1 } }], 1).reason, 'turn-open')
	assert.equal(planForget(threeTurns(), 9).reason, 'turn-not-found')
	assert.equal(planForget([{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'turn/end', seq: 1, data: { turn: 1 } }], 1).reason, 'nothing-to-forget')
})

test('forgetIn appends the compaction transaction the Host admits outside a turn', () => {
	const events = threeTurns()
	const session = recordingSession(events)
	const result = forgetIn(session, 2)

	assert.equal(result.forgotten, true)
	assert.equal(result.removed, 4)
	assert.ok(result.compactionId)

	const [start, summary, checkpoint, end] = session.appended
	assert.deepEqual(session.appended.map((event) => event.type), [
		'compaction/start',
		'compaction/summary',
		'user/message',
		'compaction/end',
	])

	// The gate must be opened and closed with no turn owner, because no turn is open.
	assert.equal(start.data.turn, null)
	assert.equal(end.data.turn, null)
	assert.equal(end.data.compactionId, start.data.compactionId)
	assert.equal(end.data.error, undefined)

	// The summary names the exact span the checkpoint replaces.
	assert.deepEqual(summary.data.shadowedRange, { start: 8, end: 15 })
	assert.deepEqual(summary.data.shadowedSeqs, [8, 9, 14, 15])
	assert.ok(summary.data.shadowedTokenCount > 0)

	// The replacement node must be a checkpoint, not a user turn and not a
	// step-scoped developer message.
	assert.equal(checkpoint.data.source.kind, 'compact-checkpoint')
	assert.equal(checkpoint.data.source.compactionId, start.data.compactionId)
	assert.deepEqual(checkpoint.surfaceOp, { op: 'replace', startSeq: 8, endSeq: 15 })
	assert.deepEqual(checkpoint.sourceEventSeqs, [start.seq, summary.seq, 8, 9, 14, 15])
})

test('forgetIn closes a compaction it opened when a later append fails', () => {
	const events = threeTurns()
	const appended = []
	let calls = 0
	const session = {
		snapshotEvents: () => events,
		append(type, data) {
			calls += 1
			if (calls === 3) throw new Error('host refused the checkpoint')
			const event = { type, seq: events.length + appended.length, data }
			appended.push(event)
			return event
		},
	}
	const result = forgetIn(session, 2)
	assert.equal(result.forgotten, false)
	assert.equal(result.reason, 'host refused the checkpoint')
	const closer = appended.at(-1)
	assert.equal(closer.type, 'compaction/end')
	assert.equal(closer.data.error, 'host refused the checkpoint')
})

test('forgetIn reports an unreadable log instead of throwing', () => {
	const result = forgetIn(
		{
			snapshotEvents() {
				throw new Error('gone')
			},
		},
		1,
	)
	assert.deepEqual(result, { forgotten: false, reason: 'log-unavailable' })
})
