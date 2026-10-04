<template>
  <div id="app">
    <window-size />
    <div>
      <router-view />
    </div>
  </div>
</template>

<script>
import WindowSize from "@/components/WindowSize.vue";
import { EventBus } from "@/eventBus";

export default {
  components: {
    WindowSize
  },
  methods: {
    initializeWebSocketSupport() {
      var _this = this;
      var scheme = window.location.protocol === "https:" ? "wss://" : "ws://";
      var chatSocket = new WebSocket(
        scheme + window.location.host + "/ws/notifications/"
      );
      // Reset the backoff on a socket that actually connected, so one blip
      // does not leave the next retry waiting 30s.
      chatSocket.onopen = function() {
        _this.retryDelay = 1000;
      };
      // Nothing in here may reject into nowhere. Nothing awaits a WebSocket
      // event handler, so a rejected dispatch had no caller to reach: console
      // noise in a browser, and under node it takes the process down.
      //
      // And the two refreshes on "update" are independent -- one is the tab's
      // unread count, the other is the messages themselves -- so neither may
      // cancel the other. `fetchMessages` used to be the second `await`, which
      // meant a single failed unread count silently stopped new messages
      // rendering, on a socket that stayed open and healthy and so never
      // triggered the reconnect that might have papered over it.
      var ignoreFailure = function() {};
      chatSocket.onmessage = function(e) {
        var data = JSON.parse(e.data);
        var message = data["message"];
        if (message === "update") {
          _this.$store.dispatch("fetchUnreadMessages").catch(ignoreFailure);
          _this.$store.dispatch("fetchMessages").catch(ignoreFailure);
          EventBus.$emit("update");
        } else if (message === "update_rooms") {
          _this.$store.dispatch("fetchRooms").catch(ignoreFailure);
        } else if (message === "room_delete") {
          const { room_id } = data.data;
          if (_this.$store.state.selectedRoom === room_id) {
            _this.$store.commit("SET_SELECTED_ROOM", null);
          }
          _this.$store.commit("REMOVE_ROOM", room_id);
        } else if (message === "update_received") {
          _this.$store
            .dispatch("fetchReceivedInvitations")
            .catch(ignoreFailure);
        } else if (message === "update_sent") {
          _this.$store.dispatch("fetchSentInvitations").catch(ignoreFailure);
        } else if (message === "writing") {
          EventBus.$emit("writing", data.data);
        } else if (message === "update_message") {
          const { kind, message_id } = data.data;
          if (kind === "all_received") {
            _this.$store.commit("MARK_MESSAGE_ALL_RECEIVED", message_id);
          } else if (kind === "all_read") {
            _this.$store.commit("MARK_MESSAGE_ALL_READ", message_id);
          }
        }
      };
      chatSocket.onclose = function() {
        _this.reconnectWebSocket();
      };
    },
    reconnectWebSocket() {
      // onclose used to be empty, so a single daphne restart -- or one network
      // blip -- ended real-time updates for this tab for the rest of the
      // session: no error, the chat just quietly stopped updating. Back off to
      // 30s so a server that is genuinely down is not hammered.
      this.retryDelay = Math.min((this.retryDelay || 1000) * 2, 30000);
      setTimeout(this.initializeWebSocketSupport, this.retryDelay);
    }
  },
  async created() {
    // First, and deliberately not the last line of the chain below. An awaited
    // chain stops at the first rejection, so a socket connected on the last
    // line was one flaky `/api/v1/me` away from never existing -- and unlike a
    // fetch that failed, a missing socket is silent and lasts the whole
    // session: no new messages, no room or invitation updates, no error. The
    // socket also cannot be waiting on any of this -- it authenticates off the
    // session cookie, not off the profile -- and nothing below can abort it.
    // Not `await`ed: initializeWebSocketSupport is not async and returns
    // undefined, so the await was a no-op that read like a wait.
    this.initializeWebSocketSupport();
    // `Promise.all`, not a sequence of awaits. Awaiting one before dispatching
    // the next meant each of these was reachable only if all the ones above it
    // had succeeded -- and `fetchUserProfile` is the first of them, so an
    // expired session (a 401 on the one request at the top) left the app up
    // and completely empty: no rooms, no messages, no invitations, and nothing
    // said why. There is no router guard and no failure handling on this side,
    // so "empty" was all a user ever saw of it.
    //
    // Order is safe to drop: item 9 made every merge into the store
    // order-independent by keying on id and recomputing counts, so these were
    // never waiting on each other's results -- only on each other's timing.
    //
    // `Promise.all` still rejects on the first failure, which propagates out of
    // `created()` and keeps a genuine failure visible instead of swallowing it.
    // What changes is that it can no longer *cancel* the other six: they are
    // already in flight by then, so nothing about their outcome depends on the
    // one that failed.
    await Promise.all([
      this.$store.dispatch("fetchUserProfile"),
      this.$store.dispatch("fetchSentInvitations"),
      this.$store.dispatch("fetchReceivedInvitations"),
      // Older pending messages and the recent ones are independent too.
      this.$store.dispatch("fetchRooms"),
      this.$store.dispatch("fetchUnreadMessages"),
      this.$store.dispatch("fetchMessages"),
      this.$store.dispatch("fetchRecentActivity")
    ]);
  }
};
</script>

<style>
#app {
  font-family: "Avenir", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
}

#nav {
  padding: 30px;
}

#nav a {
  font-weight: bold;
  color: #2c3e50;
}

#nav a.router-link-exact-active {
  color: #42b983;
}
</style>
