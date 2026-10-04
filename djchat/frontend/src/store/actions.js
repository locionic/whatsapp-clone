import axios from "@/backend";

const actions = {
  syncDB({ commit }, { rooms, users, messages }) {
    commit("SET_ROOMS", rooms);
    commit("SET_USERS", users);
    commit("LINK_MESSAGES_TO_ROOM", messages);
  },
  fetchRooms({ dispatch }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/rooms/")
        .then(response => {
          dispatch("syncDB", {
            rooms: response.data.rooms,
            messages: response.data.messages,
            users: response.data.users
          });
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchRecentActivity({ dispatch }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/rooms/recents")
        .then(response => {
          dispatch("syncDB", {
            rooms: response.data.rooms,
            messages: response.data.messages,
            users: response.data.users
          });
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchMessages({ dispatch }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/messages/")
        .then(response => {
          dispatch("syncDB", {
            rooms: response.data.rooms,
            messages: response.data.messages,
            users: response.data.users
          });
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchPastMessages({ commit }, { firstMessageId, roomId }) {
    let endpoint = firstMessageId
      ? `/api/v1/messages/${roomId}?offset=${firstMessageId}`
      : `/api/v1/messages/${roomId}`;
    return new Promise((resolve, reject) => {
      axios
        .get(endpoint)
        .then(response => {
          commit("SET_USERS", response.data.users);
          commit("LINK_PAST_MESSAGES_TO_ROOM", {
            pastMessages: response.data.messages,
            roomId
          });
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  // `?search=` rather than paging: the same endpoint `fetchPastMessages` uses,
  // asked a different question. Results go to their own map instead of into the
  // thread -- they are the same messages with their neighbours missing, and
  // `LINK_MESSAGES_TO_ROOM` would splice them into the middle of a conversation.
  //
  // No `new Promise` wrapper, unlike every action above it: returning the axios
  // promise gives the caller the same thing to await and the same rejection to
  // catch, and the wrapper only ever forwarded both.
  searchMessages({ commit }, { room, term }) {
    // `encodeURIComponent`, because the term is arbitrary text and the URL is
    // built by hand. Bare, `the&other=x` becomes a search for "the" with an
    // unrelated parameter attached -- which runs, returns the wrong things, and
    // says nothing about it.
    return axios
      .get(`/api/v1/messages/${room}?search=${encodeURIComponent(term)}`)
      .then(response => {
        // `users` first, always: a result is rendered by `received-message`,
        // which resolves its author against `state.users` and dereferences that
        // unguarded, so a result whose author is missing renders an empty
        // subtree rather than an error.
        commit("SET_USERS", response.data.users);
        commit("SET_SEARCH_RESULTS", response.data.messages);
        return response;
      });
  },
  sendMessage({ commit }, { room, body, front_key }) {
    let payload = {
      room,
      body,
      ...(front_key ? { front_key } : {})
    };
    return new Promise((resolve, reject) => {
      axios
        .post("/api/v1/messages/", payload)
        .then(response => {
          resolve(response);
        })
        .catch(error => {
          // The message is already on screen with `sending: true` and the box is
          // already empty, and nothing else ever takes either back: `sending` is
          // only cleared when the server's own copy comes back, which it never
          // will. Here, where the rejection is, is the only place that knows.
          commit("REMOVE_FAILED_MESSAGE", { front_key, room });
          reject(error);
        });
    });
  },
  markMessageAsRead({ commit }, message_id) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/messages/unread?message_id=${message_id}`)
        .then(response => {
          commit("REMOVE_MESSAGE_FROM_UNREAD", message_id);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchUnreadMessages({ commit }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/messages/unread")
        .then(response => {
          commit("ADD_UNREAD_MESSAGES", response.data.messages);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  postWriting(none, room_id) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/rooms/${room_id}/writing`)
        .then(response => {
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  markRoomAsRead({ commit }, room_id) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/rooms/${room_id}/read`)
        .then(response => {
          commit("REMOVE_ROOM_MESSAGES_FROM_UNREAD", room_id);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchSentInvitations({ commit }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/friends/requests/sent")
        .then(response => {
          commit("SET_SENT_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  getUserIdFromEmail(none, email) {
    return new Promise((resolve, reject) => {
      // encodeURIComponent, and not for tidiness: in a query string `+` means
      // space, and the browser sends it as a `+`, so the server decodes
      // `bob+chat@gmail.com` to `bob chat@gmail.com` and finds nobody. The
      // lookup then 404s and the modal says "User not found." for an address
      // that is registered. The two sibling query strings interpolate a
      // message id and an offset -- both numbers from the app itself -- so
      // this is the one site where typed input reaches a URL.
      axios
        .get(`/api/v1/users?email=${encodeURIComponent(email)}`)
        .then(response => {
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  addFriend({ commit }, userId) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/friends/add/${userId}`)
        .then(response => {
          commit("SET_SENT_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  cancelFriendRequest({ commit }, invitationId) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/friends/requests/cancel/${invitationId}`)
        .then(response => {
          commit("SET_SENT_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchReceivedInvitations({ commit }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/friends/requests/received")
        .then(response => {
          commit("SET_RECEIVED_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  rejectFriendRequest({ commit }, invitationId) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/friends/requests/reject/${invitationId}`)
        .then(response => {
          commit("SET_RECEIVED_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  acceptFriendRequest({ commit }, invitationId) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/friends/requests/accept/${invitationId}`)
        .then(response => {
          commit("SET_RECEIVED_INVITATIONS", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  deleteRoom(none, roomId) {
    return new Promise((resolve, reject) => {
      axios
        .post(`/api/v1/rooms/${roomId}/delete`)
        .then(response => {
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchUserProfile({ commit }) {
    return new Promise((resolve, reject) => {
      axios
        .get("/api/v1/me")
        .then(response => {
          commit("SET_USER_PROFILE", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  patchUserProfile({ commit }, payload) {
    return new Promise((resolve, reject) => {
      axios
        .patch("/api/v1/me", payload)
        .then(response => {
          commit("SET_USER_PROFILE", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  fetchRoomActivity({ commit }, roomId) {
    return new Promise((resolve, reject) => {
      axios
        .get(`/api/v1/rooms/${roomId}/activity`)
        .then(response => {
          commit("SET_ROOM_ACTIVITY", response.data);
          resolve(response);
        })
        .catch(error => reject(error));
    });
  },
  createGroup(none, { group_name, participants }) {
    return new Promise((resolve, reject) => {
      // The list endpoint, not an id: there is no room to address yet. And no
      // commit afterwards - `RoomViewSet.create` pushes `update_rooms` to every
      // participant including the author, which `App.vue` already answers with
      // `fetchRooms`. `kind` is `RoomKind.GROUP`, and it is load-bearing: 1
      // builds a private room instead, which the view then refuses unless the
      // list has exactly two entries.
      axios
        .post("/api/v1/rooms/", { kind: 2, group_name, participants })
        .then(response => {
          resolve(response);
        })
        .catch(error => reject(error));
    });
  }
};

export default actions;
