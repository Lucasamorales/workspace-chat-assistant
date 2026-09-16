/** Everyday commands. Works in DMs and spaces. Owns no data of its own. */

module.exports = {
  name: 'basics',
  description: 'Help, usage, status and thread reset',

  commands: {
    help: {
      description: 'What Buddy can do',
      async run(ctx) {
        const lines = ctx.core.listCommands()
          .map(c => `• \`${c.usage || `/${c.name}`}\` — ${c.description}`);
        const where = ctx.spaceKind === 'DM'
          ? 'Just write to me here. Asana works in this DM.'
          : 'Mention @Buddy to talk to me. Asana only works in a direct message with me.';
        return [`*Buddy*`, where, '', '*Commands*', ...lines].join('\n');
      },
    },

    usage: {
      description: 'Your Claude spend this month',
      async run(ctx) {
        const u = await ctx.core.usage();
        return `This month: $${u.usd.toFixed(2)} of $${u.capUsd} `
          + `(${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} tokens in, ${u.outputTokens} out).`;
      },
    },

    reset: {
      description: 'Forget this thread\'s conversation',
      async run(ctx) {
        await ctx.core.resetThread();
        return 'Done — I\'ve forgotten this thread.';
      },
    },

    status: {
      description: 'Which connections are active',
      async run(ctx) {
        const lines = await ctx.core.moduleStatuses();
        return lines.length ? lines.join('\n') : 'Nothing to connect here.';
      },
    },
  },
};
