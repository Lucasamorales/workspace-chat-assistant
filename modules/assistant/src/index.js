/**
 * Free-form chat with Claude. Holds no logic of its own: its access rule
 * (BUDDY_ACCESS_ASSISTANT) decides who may talk to Claude through Buddy, because every
 * conversation costs money. People without it can still use modules that don't need Claude,
 * such as Kudos votes and commands.
 */

module.exports = {
  name: 'assistant',
  description: 'Chat with Claude about anything',
  conversation: true,
  examples: ['Ask me anything, the way you would ask a colleague'],
};
