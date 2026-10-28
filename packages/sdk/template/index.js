// Beacon extension. Runs in a sandbox: no require(), no Node APIs, no network unless you declare it.
// Everything goes through `ctx`, limited to the permissions in manifest.json.
module.exports = {
  // Called when the user types the keyword, e.g. "hello world".
  async query(q /*, ctx */) {
    const name = q.text || 'world'
    return [
      {
        id: 'greet',
        title: 'Hello, ' + name + '!',
        subtitle: 'Copies the greeting',
        icon: '👋',
        primary: {
          id: 'copy',
          title: 'Copy greeting',
          kind: 'copy',
          payload: { text: 'Hello, ' + name + '!' },
        },
        actions: [{ id: 'notify', title: 'Show a notification', kind: 'custom' }],
      },
    ]
  },

  // Called for kind: 'custom' actions.
  async activate(itemId, actionId, ctx) {
    if (actionId === 'notify') await ctx.notify('Hello from my extension')
  },
}
