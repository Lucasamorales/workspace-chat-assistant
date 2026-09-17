/** Everyday commands. Works in DMs and spaces. Owns no data of its own. */

module.exports = {
  name: 'basics',
  description: 'Help, usage, status and thread reset',

  commands: {
    help: {
      description: 'What Buddy can do',
      async run(ctx) {
        const examples = ctx.core.examples();
        const where = ctx.spaceKind === 'DM'
          ? ''
          : '\n\nIn here, just mention me. Asana only works in a private chat with me.';
        const commands = ctx.core.listCommands().map(c => c.usage || `/${c.name}`).join(' · ');
        return {
          title: 'Here\'s what I can do',
          text: `${examples.map(e => `• ${e}`).join('\n')}${where}\n\nPrefer typing? Sure thing: ${commands}`,
          buttons: [
            ...(await ctx.core.quickActions()),
            { text: 'My usage', command: 'usage' },
            { text: 'Start fresh', command: 'reset' },
          ],
        };
      },
    },

    usage: {
      description: 'Your Claude spend this month',
      async run(ctx) {
        const u = await ctx.core.usage();
        return `This month you've used $${u.usd.toFixed(2)} of your $${u.capUsd} allowance `
          + `(${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} tokens in, ${u.outputTokens} out).`;
      },
    },

    reset: {
      description: 'Forget this thread\'s conversation',
      async run(ctx) {
        await ctx.core.resetThread();
        return 'Fresh start! I\'ve forgotten this conversation. What\'s next?';
      },
    },

    status: {
      description: 'Which connections are active',
      async run(ctx) {
        const lines = await ctx.core.moduleStatuses();
        return lines.length ? lines.join('\n') : 'Nothing to connect here, chap.';
      },
    },
  },
};
