import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './CodexAppServerClient';

// Real OS processes: the tool deliberately escapes the app-server process group.
describe('dedicated Codex host physical termination', () => {
  it.skipIf(process.platform === 'win32')(
    'terminates a detached descendant before releasing the writer',
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'channel-process-test-'));
      const fixture = path.join(cwd, 'app-server.cjs');
      await writeFile(
        fixture,
        `
      const {spawn}=require('node:child_process');
      const fs=require('node:fs');
      const readline=require('node:readline');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const message=JSON.parse(line);
        if(message.method==='initialize') console.log(JSON.stringify({id:message.id,result:{}}));
        if(message.method==='fixture/start'){
          const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('late.txt','bad'),2000);setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
          fs.writeFileSync('pid.txt',String(child.pid));
          console.log(JSON.stringify({id:message.id,result:{pid:child.pid}}));
        }
      });
    `,
      );
      const client = new CodexAppServerClient({
        commandPath: process.execPath,
        args: [fixture],
        cwd,
        env: process.env,
        clientVersion: 'test',
        reconnectMaxAttempts: 0,
        trackProcessTree: true,
      });
      let pid: number | undefined;
      try {
        await client.connect();
        ({ pid } = await client.request<{ pid: number }>('fixture/start'));
        expect(() => process.kill(pid!, 0)).not.toThrow();
        expect(await client.closeAndConfirmTermination()).toBe(true);
        expect(() => process.kill(pid!, 0)).toThrow();
        await new Promise((resolve) => setTimeout(resolve, 2200));
        await expect(readFile(path.join(cwd, 'late.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        client.close();
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The termination assertion already confirmed the fixture exited.
          }
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
    15000,
  );
});
