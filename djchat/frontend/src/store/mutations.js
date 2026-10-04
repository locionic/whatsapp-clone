import Vue from "vue";

// Both mutations below merge into the same per-room array, and neither can
// assume its input is newer than what is already there: `GET /rooms/` ships
// each room's *newest* message and `GET /messages/` ships the older pending
// ones. `App.vue:114` fires all seven load fetches in one `Promise.all`, so
// those two land in whichever order the network finishes -- the arrival order
// is unspecified, which is precisely why this sorts rather than appending.
// Appending and prepending blindly put the newest message at the top of the
// thread on every app load. `load_path.spec.js` pins all six arrival orders of
// the three writers to these arrays.
//
// `id` sorts -- it is monotonic and is what the backend paginates on
// (`id__lt=offset`). `front_key` dedupes, and NOT `id`: a message you just
// typed has no id until the server answers, so deduping on id would collapse
// every pending message into one. Sort is stable, so unconfirmed messages keep
// the order they were typed in, at the end.
const position = message => (message.id === undefined ? Infinity : message.id);

const mergeMessages = (existing, incoming) => {
  const byFrontKey = new Map();
  [...(existing || []), ...incoming].forEach(message =>
    byFrontKey.set(message.front_key, message)
  );
  return [...byFrontKey.values()].sort((a, b) => position(a) - position(b));
};

const mutations = {
  SET_ROOMS(state, rooms) {
    if (rooms)
      rooms.forEach(element => {
        Vue.set(state.rooms, element.id, element);
      });
  },
  SET_USERS(state, users) {
    if (users)
      users.forEach(element => {
        Vue.set(state.users, element.id, element);
      });
  },
  LINK_MESSAGES_TO_ROOM(state, messages) {
    if (messages)
      messages.forEach(element => {
        let front_key = element.front_key;
        if (state.sendingPool.has(front_key)) {
          // Pending sending status
          state.sendingPool.delete(front_key);
          // The server's copy *replaces* the optimistic one, in place. Both
          // halves of that are load-bearing and neither is obvious.
          //
          // Replacing rather than assigning onto it is what makes it visible at
          // all. Both in-place spellings - `delete message.sending` and
          // `Object.assign(message, element)` - write the right values and tell
          // nobody: in Vue 2 a watcher that read `message.sending` subscribed to
          // that key's dep, not to the object's, and
          // `MessagesSection.vue:89`'s `shouldUpdateComponent` compares props
          // by identity, so a re-render carrying the same object skips the child
          // anyway. `Vue.set` re-runs the v-for, which hands the child a
          // *different* object.
          //
          // In place rather than through `mergeMessages` is what keeps the
          // thread in order. `position()` at :15 gives a message with no id
          // `Infinity`, so re-sorting on confirmation lifts a just-confirmed
          // message above one still in flight - and two POSTs are free to land
          // out of order, which put "again" on screen above the "hi" typed
          // before it. The optimistic message is already in the right slot,
          // typed-order at the end, and a confirmation does not move anything.
          //
          // SendForm commits LINK_MESSAGES_TO_ROOM before ADD_MESSAGE_TO_SENDING,
          // so the optimistic message missed the sendingPool branch and left its
          // front_key in `receivedMessages` -- a set nothing pruned. Every
          // message a user sent therefore kept one permanent reactive entry for
          // the rest of the session. This branch is where a message stops being
          // in flight, so that is where the key goes. Safe to drop it, because a
          // repeat arrival now reaches mergeMessages, which dedupes on front_key
          // anyway.
          const inRoom = state.roomMessages[element.room] || [];
          const at = inRoom.findIndex(one => one.front_key === front_key);
          Vue.set(
            state.roomMessages,
            element.room,
            // Not found means the bubble left the room between the send and the
            // confirmation - nothing in the store does that today. Appended
            // through `mergeMessages` rather than spliced, because splicing a
            // `findIndex` of -1 would silently duplicate the last message.
            at === -1
              ? mergeMessages(inRoom, [element])
              : [...inRoom.slice(0, at), element, ...inRoom.slice(at + 1)]
          );
          Vue.delete(state.receivedMessages, front_key);
        } else {
          if (element.room in state.roomMessages) {
            if (!(element.front_key in state.receivedMessages)) {
              Vue.set(
                state.roomMessages,
                element.room,
                mergeMessages(state.roomMessages[element.room], [element])
              );
              Vue.set(state.receivedMessages, element.front_key, null);
            }
          } else {
            Vue.set(state.roomMessages, element.room, [element]);
            Vue.set(state.receivedMessages, element.front_key, null);
          }
        }
      });
  },
  LINK_PAST_MESSAGES_TO_ROOM(state, { pastMessages, roomId }) {
    // `state.roomMessages[roomId]` is undefined for a room with no messages at
    // all -- /rooms/ only ever carries a last_message, and there is none -- so
    // spreading it threw a TypeError on the first open of every new chat.
    // MessagesSection catches that, so it was invisible.
    Vue.set(
      state.roomMessages,
      roomId,
      mergeMessages(state.roomMessages[roomId], pastMessages)
    );
  },
  // Search hits for the room on screen. Reset rather than merged: results
  // describe one query, so a second search replaces the first instead of
  // accumulating with it. `ADD_UNREAD_MESSAGES` is the same shape.
  SET_SEARCH_RESULTS(state, messages) {
    state.searchResults = {};
    if (messages)
      messages.forEach(element => {
        Vue.set(state.searchResults, element.id, element);
      });
  },
  SET_SELECTED_ROOM(state, roomId) {
    state.selectedRoom = roomId;
  },
  REMOVE_ROOM(state, roomId) {
    Vue.delete(state.rooms, roomId);
  },
  ADD_MESSAGE_TO_SENDING(state, message) {
    state.sendingPool.set(message.front_key, message);
  },
  // Undo a send the server refused. Three things to undo, not one: the bubble
  // (which otherwise sits on its clock icon for the rest of the session, since
  // `sending` is only ever cleared by the server's own copy arriving), the
  // sending-pool entry, and the `receivedMessages` registration.
  //
  // That last one is why this is not just "take the message back out".
  // `SendForm` commits LINK_MESSAGES_TO_ROOM *before* ADD_MESSAGE_TO_SENDING,
  // so the optimistic message misses the sendingPool branch and registers its
  // front_key as already-seen. A POST can reach the server and still reject the
  // client -- the response is lost on the way back -- and then the message is
  // real, the peer has it, and the push carries that same front_key. Leaving the
  // registration behind would make the sender's own copy of a delivered message
  // the one message the sender never sees.
  REMOVE_FAILED_MESSAGE(state, { front_key, room }) {
    state.sendingPool.delete(front_key);
    Vue.delete(state.receivedMessages, front_key);
    Vue.set(
      state.roomMessages,
      room,
      (state.roomMessages[room] || []).filter(
        message => message.front_key !== front_key
      )
    );
  },
  ADD_UNREAD_MESSAGES(state, messages) {
    state.unreadMessages = {};
    if (messages)
      messages.forEach(element => {
        Vue.set(state.unreadMessages, element.id, element.room);
      });
  },
  REMOVE_MESSAGE_FROM_UNREAD(state, message_id) {
    if (message_id in state.unreadMessages) {
      Vue.delete(state.unreadMessages, message_id);
    }
  },
  REMOVE_ROOM_MESSAGES_FROM_UNREAD(state, room_id) {
    for (let message_id in state.unreadMessages) {
      if (state.unreadMessages[message_id] === room_id) {
        Vue.delete(state.unreadMessages, message_id);
      }
    }
  },
  MARK_MESSAGE_ALL_RECEIVED(state, message_id) {
    Vue.set(state.allReceived, message_id, true);
  },
  MARK_MESSAGE_ALL_READ(state, message_id) {
    Vue.set(state.allRead, message_id, true);
  },
  SET_SENT_INVITATIONS(state, sentInvitations) {
    state.sentInvitations = {};
    if (sentInvitations)
      sentInvitations.forEach(element => {
        Vue.set(state.sentInvitations, element.id, element);
      });
  },
  SET_RECEIVED_INVITATIONS(state, receivedInvitations) {
    state.receivedInvitations = {};
    receivedInvitations.forEach(element => {
      Vue.set(state.receivedInvitations, element.id, element);
    });
  },
  SET_USER_PROFILE(state, userProfile) {
    state.userProfile = userProfile;
  },
  SET_CURRENT_WIDTH(state, width) {
    state.width = width;
  },
  SET_CURRENT_HEIGHT(state, height) {
    state.height = height;
  },
  SET_ROOM_ACTIVITY(state, activity) {
    state.roomActivity = activity;
  }
};

export default mutations;
