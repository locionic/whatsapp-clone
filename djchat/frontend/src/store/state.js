const state = {
  // Frontend selected room
  selectedRoom: null,

  // Db sync
  rooms: {},
  users: {},
  roomMessages: {},

  // Messages per day for the room whose profile is open, or null
  roomActivity: null,

  // Messages pool
  receivedMessages: {},
  unreadMessages: {},

  // Hits for the search on the room on screen, keyed by message id. Its own map
  // rather than `roomMessages`: results are the same messages with most of their
  // neighbours missing, so linking them in the way every other message arrives
  // would splice orphans into a conversation and move everything below them.
  searchResults: {},

  // Update signals
  allReceived: {},
  allRead: {},

  // Sending messages pool
  sendingPool: new Map(),

  // Invitations
  sentInvitations: {},
  receivedInvitations: {},

  // User
  userProfile: null,

  // Window Size
  width: null,
  height: null
};

export default state;
