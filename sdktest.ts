import { query } from '@anthropic-ai/claude-agent-sdk';
const q = query({
  prompt: (async function*() { yield { type: 'user' as const, message: { role: 'user' as const, content: 'hi' }, parent_tool_use_id: null, session_id: '' }; })(),
  options: { model: 'claude-haiku-4-5', cwd: process.cwd(), permissionMode: 'default' as const, canUseTool: async (_n: string, i: any) => ({ behavior: 'allow' as const, updatedInput: i }) },
});
try {
  for await (const m of q as any) {
    console.log('MSG:', m.type, m.subtype || '');
    if (m.type === 'system') { process.exit(0); }
  }
} catch (e: any) { console.log('ERR:', e.message); }
