import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { prepareChannelLaunch } from './agentClient';
import { CodexChannelHost, type CodexChannelStart } from './host';

// A real executable fixture, not a mocked spawn: exercises stdin, shared protocol adapters,
// native session continuation, file side effects and durable host recovery without a paid model.
const cli = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const send = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const runtime = process.env.FIXTURE_RUNTIME;
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 99.0.0'); process.exit(0); }
fs.writeFileSync('argv.json', JSON.stringify(args));
const session = 'native-fixture-session';
const work = (prompt) => {
  fs.appendFileSync('deliveries.jsonl', JSON.stringify({ prompt, args }) + '\n');
  fs.writeFileSync('tool-result.txt', 'native tool ran: ' + process.env.FIXTURE_VALUE);
  fs.writeFileSync('child-env.json', JSON.stringify({ hostSecret: process.env.CHANNEL_HOST_ONLY }));
};
if (runtime === 'grok-build') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: u } });
    if (m.method === 'initialize') reply({ protocolVersion: 1 });
    if (m.method === 'session/new') reply({ sessionId: session });
    if (m.method === 'session/load') reply({});
    if (m.method === 'session/prompt') {
      work(m.params.prompt[0].text);
      update({ sessionUpdate: 'tool_call', toolCallId: 'write-1', title: 'Write', kind: 'edit', status: 'in_progress', rawInput: { path: 'tool-result.txt' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write-1', status: 'completed', content: [{ type: 'text', text: 'written' }] });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tool execution complete' } });
      reply({ stopReason: 'end_turn' });
    }
  });
} else {
  let input = '';
  process.stdin.on('data', (data) => input += data);
  process.stdin.on('end', async () => {
    work(['amp', 'claude-code'].includes(runtime) ? JSON.parse(input).message.content[0].text : input);
    if (process.env.FIXTURE_BACKGROUND) {
      const child = require('node:child_process').spawn(process.execPath, ['-e', "const fs=require('node:fs'); const t=setInterval(()=>fs.appendFileSync('background.txt','x'),30); setTimeout(()=>clearInterval(t),20000)"], { stdio: 'ignore' });
      child.unref();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (runtime === 'pi') {
      send({ type: 'session', version: 3, id: session, cwd: process.cwd() });
      send({ type: 'turn_start' });
      send({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: { path: 'tool-result.txt' } });
      send({ type: 'tool_execution_end', toolCallId: 'write-1', isError: false, result: { content: [{ type: 'text', text: 'written' }] } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Tool execution ' } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Tool execution complete' }], stopReason: process.env.FIXTURE_ERROR ? 'error' : 'stop', errorMessage: process.env.FIXTURE_ERROR && 'Model request failed' } });
      send({ type: 'turn_end' });
      send({ type: 'agent_end' });
      send({ type: 'agent_settled' });
    } else if (runtime === 'amp' || runtime === 'claude-code') {
      send({ type: 'system', subtype: 'init', session_id: session, tools: ['Write', 'Bash', 'mcp__example'] });
      send({ type: 'assistant', message: { id: 'assistant-tool', content: [{ type: 'tool_use', id: 'write-1', name: 'Write', input: { path: 'tool-result.txt' } }] } });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1', content: 'written' }] } });
      send({ type: 'assistant', message: { id: 'assistant-answer', content: [{ type: 'text', text: 'Tool execution complete' }] } });
      send({ type: 'result', subtype: process.env.FIXTURE_ERROR ? 'error_during_execution' : 'success', is_error: !!process.env.FIXTURE_ERROR, errors: process.env.FIXTURE_ERROR ? ['Model request failed'] : [], session_id: session });
    } else {
      send({ type: 'thread.started', thread_id: session });
      send({ type: 'turn.started' });
      send({ type: 'item.started', item: { id: 'write-1', type: 'command_execution', command: 'write tool-result.txt', status: 'in_progress' } });
      send({ type: 'item.completed', item: { id: 'write-1', type: 'command_execution', command: 'write tool-result.txt', status: 'completed', exit_code: 0, aggregated_output: 'written' } });
      send({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Tool execution complete' } });
      send({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    }
  });
}
`;

describe('Channel delivery through standalone subprocess protocols', () => {
  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    '%s executes tools in a non-Git directory and resumes exactly once',
    async (runtime) => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-delivery-')));
      try {
        const command = path.join(root, 'agent-fixture.cjs');
        await writeFile(command, cli, { mode: 0o700 });
        const journal = path.join(root, 'receipts');
        vi.stubEnv('CHANNEL_HOST_ONLY', 'must-not-be-reinherited');
        const host = new CodexChannelHost(journal, async (request) => ({
          ...(await prepareChannelLaunch(request)),
          inheritEnv: false,
          env: { PATH: process.env.PATH!, ...request.provider?.env },
        }));
        const input: CodexChannelStart = {
          ownerId: 'owner',
          runId: 'run-1',
          cwd: root,
          fence: 1,
          model: '',
          runtime,
          provider: {
            type: runtime,
            command,
            env: { FIXTURE_RUNTIME: runtime, FIXTURE_VALUE: 'configured' },
          },
          manifest: {
            cutoffSequence: 1,
            messages: [
              {
                id: 'm1',
                sequence: 1,
                threadId: null,
                author: { id: 'owner', name: 'Owner', type: 'human' },
                content: 'Write a file',
              },
            ],
            requestMessageId: 'm1',
            sessionGeneration: 1,
            source: 'reconstructed',
            threadId: null,
          },
        };
        await expect(host.probe(root, runtime, input.provider)).resolves.toMatchObject({
          available: true,
        });
        await Promise.all([host.start(input), host.start(input)]);
        await Promise.all([...host['runs'].values()].map((entry) => entry.done));
        const result = await host.inspect('owner', 'run-1');
        expect(result).toMatchObject({
          status: 'completed',
          content: 'Tool execution complete',
          acceptance: 'accepted',
          runtimeCompleted: true,
          sessionId: 'native-fixture-session',
          toolCalls: 1,
        });
        expect(await readFile(path.join(root, 'tool-result.txt'), 'utf8')).toBe(
          'native tool ran: configured',
        );
        expect(JSON.parse(await readFile(path.join(root, 'child-env.json'), 'utf8'))).toEqual({});
        expect(result?.evidence).toBeUndefined();
        const restarted = new CodexChannelHost(journal);
        await restarted.start(input);
        const followup = {
          ...input,
          runId: 'run-2',
          sessionId: result!.sessionId,
          manifest: {
            ...input.manifest,
            source: 'incremental' as const,
            cutoffSequence: 2,
            requestMessageId: 'm2',
            messages: [
              { ...input.manifest.messages[0], id: 'm2', sequence: 2, content: 'Continue' },
            ],
          },
        };
        await restarted.start(followup);
        await Promise.all([...restarted['runs'].values()].map((entry) => entry.done));
        expect((await restarted.inspect('owner', 'run-2'))?.status).toBe('completed');
        const deliveries = (await readFile(path.join(root, 'deliveries.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(deliveries).toHaveLength(2);
        expect(deliveries[1].prompt).toContain('"contextMode":"delta"');
        expect(deliveries[1].prompt).not.toContain('Write a file');
        if (runtime !== 'grok-build')
          expect(deliveries[1].args).toContain('native-fixture-session');
        if (runtime === 'claude-code' || runtime === 'pi') {
          const resumeFlag = runtime === 'claude-code' ? '--resume' : '--session-id';
          expect(deliveries[0].args).not.toContain(resumeFlag);
          const resumeIndex = deliveries[1].args.indexOf(resumeFlag);
          expect(resumeIndex).toBeGreaterThanOrEqual(0);
          expect(deliveries[1].args[resumeIndex + 1]).toBe('native-fixture-session');
        }
        const args: string[] = JSON.parse(await readFile(path.join(root, 'argv.json'), 'utf8'));
        expect(args).not.toContain('--settings-file');
        expect(args).not.toContain('--max-turns');
        expect(args).not.toContain('--disable-web-search');
        expect(args).not.toContain('--no-subagents');
        expect(args.join(' ')).not.toContain('channel-budget');

        const changed = new CodexChannelHost(journal, async (request) => ({
          ...(await prepareChannelLaunch(request)),
          bindingKey: 'different-provider',
        }));
        await changed.start({ ...followup, runId: 'binding-change' });
        await Promise.all([...changed['runs'].values()].map((entry) => entry.done));
        expect(await changed.inspect('owner', 'binding-change')).toMatchObject({
          status: 'failed',
          physicalStopped: true,
          error: expect.stringContaining('rebuild'),
        });
        expect(
          (await readFile(path.join(root, 'deliveries.jsonl'), 'utf8')).trim().split('\n'),
        ).toHaveLength(2);
        // An explicitly rebuilt session receives full history, never the rejected delta alone.
        await changed.start({
          ...input,
          runId: 'rebuilt',
          manifest: { ...input.manifest, sessionGeneration: 2 },
        });
        await Promise.all([...changed['runs'].values()].map((entry) => entry.done));
        expect((await changed.inspect('owner', 'rebuilt'))?.status).toBe('completed');

        if (runtime === 'claude-code' || runtime === 'pi') {
          await host.start({
            ...input,
            runId: 'error-turn',
            provider: {
              ...input.provider!,
              env: { ...input.provider!.env, FIXTURE_ERROR: '1' },
            },
          });
          await Promise.all([...host['runs'].values()].map((entry) => entry.done));
          const failed = await host.inspect('owner', 'error-turn');
          expect(failed).toMatchObject({ status: 'failed', physicalStopped: true });
          expect(failed?.content).toBeUndefined();
          expect(failed?.runtimeCompleted).not.toBe(true);
        }
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { force: true, recursive: true });
      }
    },
    15000,
  );

  it.each(['codex', 'claude-code', 'pi'] as const)(
    '%s keeps completed background tools alive until an explicit stop terminates them',
    async (runtime) => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-background-')));
      const host = new CodexChannelHost(path.join(root, 'receipts'));
      try {
        const command = path.join(root, 'agent-fixture.cjs');
        await writeFile(command, cli, { mode: 0o700 });
        await host.start({
          ownerId: 'owner',
          runId: 'background',
          cwd: root,
          fence: 1,
          model: '',
          runtime,
          provider: {
            type: runtime,
            command,
            env: { FIXTURE_RUNTIME: runtime, FIXTURE_BACKGROUND: '1' },
          },
          manifest: {
            cutoffSequence: 1,
            messages: [],
            requestMessageId: 'm1',
            sessionGeneration: 1,
            source: 'reconstructed',
            threadId: null,
          },
        });
        await Promise.all([...host['runs'].values()].map((entry) => entry.done));
        expect(await host.inspect('owner', 'background')).toMatchObject({
          runtimeCompleted: true,
          physicalStopped: false,
          status: 'completed',
        });
        const before = await readFile(path.join(root, 'background.txt'), 'utf8');
        await vi.waitFor(async () =>
          expect(
            (await readFile(path.join(root, 'background.txt'), 'utf8')).length,
          ).toBeGreaterThan(before.length),
        );
        expect(await host.stop('owner', 'background', 1)).toMatchObject({
          status: 'stopped',
          physicalStopped: true,
        });
        const stopped = await readFile(path.join(root, 'background.txt'), 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await readFile(path.join(root, 'background.txt'), 'utf8')).toBe(stopped);
      } finally {
        await host.stop('owner', 'background', 1);
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
