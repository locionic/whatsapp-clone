<template>
  <div class="relative">
    <div
      class="flex items-center justify-between profile-panel border-b"
      style="height: 10vh;"
    >
      <!-- Group Avatar -->
      <div class="avatar-container flex">
        <!-- Optional slot -->
        <slot></slot>

        <div
          v-if="selectedRoom"
          class="flex items-center"
          @click="$emit('profile-sidenav')"
        >
          <!-- Avatar -->
          <div
            class="avatar-circle flex-none mx-3 select-none cursor-pointer hover:shadow-md"
            :style="
              `background-color: rgb(${getColor.red},${getColor.green},${getColor.blue}); transition: box-shadow 0.3s;`
            "
          >
            {{ currentRoom.group_name
              ? currentRoom.group_name.charAt(0).toUpperCase()
              : "" }}
          </div>

          <!-- Profile Name -->
          <p class="cursor-pointer">
            {{ currentRoom.group_name || "" }}
          </p>
        </div>
      </div>

      <!-- Menu Icon -->
      <Menu />
    </div>

    <!-- Fallback when no room is selected yet -->
    <div v-if="!$store.state.selectedRoom" class="alert">
      <div class="select-none mt-6">
        <!-- Chat Icon -->
        <i
          class="material-icons mb-4 bg-white p-6 
        shadow-lg rounded-full"
          style="font-size: 48px;"
        >
          <!-- chat_bubble_outline -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24"
            viewBox="0 0 24 24"
            width="24"
          >
            <path d="M0 0h24v24H0V0z" fill="none" />
            <path
              d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"
            />
          </svg>
        </i>

        <!-- Message -->
        <p class=" py-2 px-4 bg-white shadow-lg rounded-full">
          Talk to a Friend!
        </p>
      </div>
    </div>

    <!-- Search bar. Only when a room is open: there is nothing to search without
    one, and the endpoint is `/messages/<room_id>`. A `type="search"` input rather
    than a textarea -- this one is for a term, not for prose, and the browser's
    clear button comes free. -->
    <div
      v-if="$store.state.selectedRoom"
      class="flex items-center px-3 py-2 bg-white border-b"
    >
      <input
        type="search"
        v-model="searchTerm"
        @keydown.enter.exact.prevent="search()"
        placeholder="Search this conversation"
        aria-label="Search this conversation"
        class="flex-1 px-2 py-1 text-sm bg-gray-100 rounded border-none focus:outline-none focus:shadow-outline"
      />
      <button
        type="button"
        @click="search()"
        class="text-sm ml-2 px-3 py-1 text-white bg-blue-500 rounded cursor-pointer hover:bg-blue-600"
      >
        Search
      </button>
      <button
        type="button"
        v-if="searched"
        @click="closeSearch()"
        class="text-sm ml-2 px-3 py-1 text-gray-700 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
      >
        Back to conversation
      </button>
    </div>

    <!-- The last refusal. Without it a rejected search and a conversation with
    nothing matching look identical, and "no results" quietly becomes "it broke". -->
    <p
      v-if="searchError"
      role="alert"
      class="px-3 py-2 text-sm text-red-700 bg-red-100 border-b"
    >
      {{ searchError }}
    </p>

    <!-- Messages window -->
    <div
      ref="messages"
      class="messages-section chat scrollbar overflow-y-auto overflow-x-hidden border-b"
      style="height: 75vh;"
      @scroll="onScroll"
    >
      <div v-if="$store.state.selectedRoom">
        <!-- Fetching older messages alert -->
        <div
          v-if="fetchingMessages"
          class="py-1"
          style="background-color: rgba(255,255,255,0.7);"
        >
          <p class="text-sm">Loading older messages.</p>
        </div>

        <!-- Search results, in place of the thread. Same two components, but fed
        `searchResults`: these are the same messages with most of their neighbours
        missing, so splicing them into `roomMessages` would move every message
        below them. That is why results have their own store map at all. -->
        <div v-if="searched" class="mx-auto max-w-3xl mb-3 px-1">
          <p class="text-sm py-2 px-2 text-gray-700">
            {{ searchResults.length }}
            {{ searchResults.length === 1 ? "message" : "messages" }} matching
          </p>
          <div v-for="message in searchResults" :key="message.id">
            <sent-message :message="message" v-if="message.is_owner" />
            <received-message :message="message" v-else />
          </div>
        </div>

        <!-- Messages section -->
        <div v-else class="mx-auto max-w-3xl mb-3 px-1">
          <div v-for="day in dayGroups" :key="day.key">
            <!-- Day separator. Not in the results panel above: hits are the same
            messages with their neighbours missing, so a date there reads as
            though it headed the whole thread. -->
            <p
              class="day-separator text-center text-xs text-gray-600 py-2 select-none"
            >
              {{ day.label }}
            </p>
            <div v-for="message in day.messages" :key="message.id">
              <!-- Sent or received -->
              <sent-message :message="message" v-if="message.is_owner" />
              <received-message :message="message" v-else />
            </div>
          </div>
        </div>

        <!-- Fetching older messages alert -->
        <div
          v-if="!searched && newMessagesReceived"
          class="py-1 sticky flex justify-center select-none"
          style="background-color: rgba(255,255,255,0.7);"
        >
          <p class="text-sm mx-1">New messages received</p>
          <button
            type="button"
            @click="scrollToBottom()"
            class="text-sm mx-1 text-blue-500
            cursor-pointer font-medium hover:font-semibold p-0 bg-transparent border-0"
          >
            (go to bottom)
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import Menu from "@/components/Menu.vue";
import SentMessage from "./SentMessage.vue";
import ReceivedMessage from "./ReceivedMessage.vue";

import dateFormat from "dateformat";

import { colorOffsets, getHash } from "@/global/variables.js";

// "Today", "Yesterday", or the date. Local midnight, and the previous day
// found with `setDate` rather than `midnight - 86400000`, which is an hour out
// either side of a DST change -- and this is the code that runs on the day of
// one, once per group.
const dayLabel = when => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (when >= midnight) return "Today";
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  if (when >= yesterday) return "Yesterday";
  return dateFormat(when, "dddd, mmmm dS");
};

export default {
  data() {
    return {
      fetchingMessages: false,
      fixScrollToBottom: true,
      noMoreMessages: false,
      newMessagesReceived: false,
      showContext: false,
      searchTerm: "",
      searched: false,
      // Set only here, so a search that failed has somewhere to say so. Without
      // it a refusal and a conversation with no matches are the same screen --
      // an empty result list reading as "nothing here says that". Same reasoning
      // as Invitations.vue's, for the same reason.
      searchError: ""
    };
  },
  components: {
    SentMessage,
    ReceivedMessage,
    Menu
  },
  methods: {
    search() {
      const term = this.searchTerm.trim();
      // An empty box is not a search. Sending it would replace the thread with
      // an empty result list and a header claiming there were no results for a
      // query that was never made.
      if (!term || !this.selectedRoom) return;
      // Cleared up front, not on failure, so a refusal replaces the previous
      // refusal instead of stacking on a stale one.
      this.searchError = "";
      this.$store
        .dispatch("searchMessages", { room: this.selectedRoom, term })
        .then(() => {
          this.searched = true;
        })
        .catch(() => {
          this.searchError = "The search could not be completed.";
        });
    },
    closeSearch() {
      // The store map too, not just this component's flag. `searchResults` is
      // one map for the whole app; leaving it populated is what makes the next
      // open show the previous conversation's hits until something overwrites
      // them.
      this.$store.commit("SET_SEARCH_RESULTS", []);
      this.searched = false;
      this.searchTerm = "";
      this.searchError = "";
    },
    scrollToBottom() {
      let sc = this.$refs["messages"];
      sc.scrollTo(0, sc.scrollHeight);
    },
    onScroll({ target: { scrollTop, clientHeight, scrollHeight } }) {
      if (scrollTop + clientHeight >= scrollHeight) {
        this.fixScrollToBottom = true;
        this.newMessagesReceived = false;
      } else {
        this.fixScrollToBottom = false;
      }
      if (scrollTop < 50 && !this.fetchingMessages) {
        this.fetchPastMessages();
      }
    },
    fetchPastMessages() {
      // Guarded here rather than in the `selectedRoom` watcher, because onScroll
      // reaches this method too -- the scroll pane stays mounted after a chat is
      // closed. And closing is an ordinary gesture, not an edge case:
      // SideRooms.vue:62 commits SET_SELECTED_ROOM(null) just for closing the
      // room drawer, ContactProfile.vue:148 for deleting the chat, and App.vue:42
      // when a peer removes you. All three used to ask for `messages/null`, which
      // chat/api/urls.py:9 -- `messages/<int:room_id>` -- cannot match, so each
      // 404ed at URL resolution and the rejection was swallowed by the catch
      // below. There is no history to page through with no room open.
      if (!this.$store.state.selectedRoom) return;
      if (!this.fetchingMessages && !this.noMoreMessages) {
        this.fetchingMessages = true;
        let roomId = this.$store.state.selectedRoom;
        let firstMessageId = this.messages ? this.messages[0].id : null;
        this.$store
          .dispatch("fetchPastMessages", {
            firstMessageId,
            roomId
          })
          .then(response => {
            // This page was asked for on behalf of one specific room, and the
            // user is quite possibly not looking at it any more. `noMoreMessages`
            // is component state, not per-room, so a late "nothing older" from
            // the chat they just left would cap the one they opened -- and
            // nothing re-arms it until they select a third room. Which room it
            // was for is in the response, so match it.
            //
            // `fetchingMessages` is left alone on a mismatch on purpose: the
            // selectedRoom watcher already cleared it when the room changed,
            // and clearing it again would let a second fetch start for the room
            // that is on screen now.
            if (response.data.room.id !== this.$store.state.selectedRoom)
              return;
            this.fetchingMessages = false;
            if (!response.data.messages.length) {
              this.noMoreMessages = true;
            }
          })
          .catch(() => {
            this.fetchingMessages = false;
          });
      }
    },
    hasUnreadMessagesInRoom() {
      return Object.values(this.$store.state.unreadMessages).includes(
        this.selectedRoom
      );
    }
  },
  mounted() {
    this.scrollToBottom();
  },
  computed: {
    getColor() {
      let username = this.currentRoom.group_name || "";
      let { red, green, blue } = colorOffsets;
      red = (getHash(username) + red) ** 2 % 256;
      green = (getHash(username) + green) ** 2 % 256;
      blue = (getHash(username) + blue) ** 2 % 256;
      return {
        red,
        green,
        blue
      };
    },
    selectedRoom() {
      return this.$store.state.selectedRoom;
    },
    // The only place the header resolves the selection. Every writer of
    // `selectedRoom` puts the room into `rooms` first -- `UsersSection.vue:100`
    // picks an id it read out of the map, and `App.vue:52-54` clears the
    // selection before `REMOVE_ROOM` deletes it -- with one exception the
    // invariant never covered: `selectedRoom` starts as `null` (state.js:3) and
    // `Rooms.vue:13` mounts this component unconditionally, so the pane renders
    // once per load with nothing selected. `rooms[null]` is undefined and the
    // read throws, which kills the whole subtree, not just the header.
    currentRoom() {
      return this.$store.state.rooms[this.selectedRoom] || {};
    },
    messages() {
      let selectedRoom = this.$store.state.selectedRoom;
      return this.$store.state.roomMessages[selectedRoom];
    },
    // One group per calendar day, in the order the thread already has. Grouped
    // here rather than in the store because `roomMessages` is a flat array that
    // three writers merge into (`mergeMessages`), and a nested structure would
    // have to be rebuilt by every one of them.
    //
    // No guard for an unparseable `timestamp`, deliberately. `dateformat` throws
    // on an Invalid Date, and `SentMessage.time` and `ReceivedMessage.time`
    // already call it on the same value, so a message without a timestamp kills
    // its bubble either way; guarding it here would protect nothing and cost a
    // branch that no test can reach.
    dayGroups() {
      const groups = [];
      let current = null;
      (this.messages || []).forEach(message => {
        const when = new Date(message.timestamp);
        const key = dateFormat(when, "yyyy-mm-dd");
        if (!current || current.key !== key) {
          current = { key, label: dayLabel(when), messages: [] };
          groups.push(current);
        }
        current.messages.push(message);
      });
      return groups;
    },
    searchResults() {
      return Object.values(this.$store.state.searchResults);
    }
  },
  watch: {
    selectedRoom() {
      // The hits belong to the room that was on screen. `searchResults` is one
      // map for the whole app and nothing downstream can tell a stray hit from
      // a real one -- a result carries its own `room`, and no code compares it
      // to the selection -- so leaving them here shows one conversation's
      // messages inside another. Every other path off this pane (`App.vue:42`
      // on being removed, `SideRooms.vue:62` on closing the drawer) writes
      // `selectedRoom` too, so one line covers all three.
      this.closeSearch();
      setTimeout(() => this.scrollToBottom(), 10);
      this.fetchingMessages = false;
      this.noMoreMessages = false;
      if (!this.messages || this.messages.length < 8) {
        this.fetchPastMessages();
      }
      if (this.hasUnreadMessagesInRoom()) {
        this.$store.dispatch("markRoomAsRead", this.selectedRoom);
      }
    },
    messages() {
      this.$nextTick(() => {
        if (this.fixScrollToBottom) {
          this.scrollToBottom();
        }
      });
      if (!this.fixScrollToBottom && !this.fetchingMessages) {
        this.newMessagesReceived = true;
      }
    }
  }
};
</script>

<style scoped>
div.sticky {
  position: -webkit-sticky; /* Safari */
  position: sticky;
  bottom: 0;
}

.chat {
  background-image: url("~@/assets/imgs/main-bg.png");
  background-repeat: repeat;
}

.alert {
  left: 50%;
  top: 50%;
  -webkit-transform: translate(-50%, -50%);
  -moz-transform: translate(-50%, -50%);
  transform: translate(-50%, -50%);
  position: absolute;
}

.avatar-circle {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 25px;
  color: #fff;
  line-height: 40px;
  text-align: center;
  font-weight: 600;
}

/* Scrollbar */
/* width */
.scrollbar::-webkit-scrollbar {
  width: 5px;
}

/* Track */
.scrollbar::-webkit-scrollbar-track {
  background: #f1f1f1;
}

/* Handle */
.scrollbar::-webkit-scrollbar-thumb {
  background: #888;
}

/* Handle on hover */
.scrollbar::-webkit-scrollbar-thumb:hover {
  background: #555;
}
</style>
