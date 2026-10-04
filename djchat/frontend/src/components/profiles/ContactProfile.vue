<template>
  <div class="contact-profile">
    <!-- Right Sidenavs -->
    <div
      class="absolute user-profile-sidenav right-0 bg-gray-200 overflow-y-auto"
      :style="
        `height: 100%; width: ${Math.min(400, width)}px; z-index:10; 
            transform: translate(${rightSidenav ? 0 : 150}%);
            transition: transform 0.5s ease-out;`
      "
    >
      <div class="w-full">
        <div
          class="flex justify-between items-center px-5 bg-teal-500"
          style="height: 10vh;"
        >
          <!-- Close Button -->
          <button
            aria-label="close"
            class="text-xl text-white closebtn"
            @click.prevent="$emit('toggleRightSidenav')"
          >
            ×
          </button>

          <!-- Header -->
          <div class="flex-grow">
            <p class="text-white text-center text-xl">Contact Details</p>
          </div>
        </div>

        <!-- User Details -->
        <div class="user-details">
          <div class="bg-white shadow py-8">
            <!-- Avatar -->
            <div
              class="avatar-main-circle flex-none mx-auto 
                  select-none cursor-pointer hover:shadow-md"
              :style="
                `background-color: rgb(${getColor.red},${getColor.green},${getColor.blue}); 
          transition: box-shadow 0.3s;`
              "
            >
              {{ getAvatarName }}
            </div>

            <!-- Username -->
            <div class="text-center mt-3">
              <p class="text-lg">{{ getUsername }}</p>
            </div>
          </div>

          <!-- Description -->
          <form class="bg-white shadow py-3 px-6 mt-3">
            <p class="text-left text-sm text-teal-500">Description</p>
            <div class="flex items-center py-2">
              <p class="cursor-default">{{ getUserTagline }}</p>
            </div>
          </form>

          <!-- Activity -->
          <div class="bg-white shadow py-3 px-6 mt-3">
            <p class="text-left text-sm text-teal-500">Activity</p>
            <div v-if="getActivity">
              <p class="text-xs text-gray-600 mb-1">
                {{ getActivity.total }} messages in the last
                {{ getActivity.days }} days, busiest day {{ getActivity.peak }}
              </p>
              <svg
                class="activity"
                role="img"
                :aria-label="
                  `Messages per day over the last ${getActivity.days} days.
                   Busiest day: ${getActivity.peak} messages.`
                "
                :viewBox="`0 0 ${getBars.length} ${barHeight}`"
                preserveAspectRatio="none"
              >
                <rect
                  v-for="(bar, i) in getBars"
                  :key="bar.date"
                  :x="i"
                  :y="barHeight - bar.h"
                  width="0.85"
                  :height="bar.h"
                />
              </svg>
              <div class="flex justify-between text-xs text-gray-500 mt-1">
                <span>{{ getActivity.days }} days ago</span>
                <span>today</span>
              </div>
            </div>
            <p v-else-if="activityLoaded" class="text-sm text-gray-500">
              No messages in this chat yet
            </p>
          </div>

          <!-- Export -->
          <div class="bg-white shadow py-5 px-6 mt-3">
            <div class="text-left flex items-center">
              <i class="material-icons text-blue-600" style="font-size: 28px;"
                >download</i
              >
              <p class="text-blue-600 text-lg mx-3">Export</p>
            </div>
            <!-- Two anchors and nothing else. `RoomExportAPIView` sends
                 Content-Disposition on both formats, so the browser downloads
                 the file and the tab stays on the app -- no axios action, no
                 blob, no object URL to revoke, no state. The links are the
                 whole client. -->
            <div class="flex mt-3">
              <a
                v-for="format in exportFormats"
                :key="format"
                :href="exportUrl(format)"
                class="text-sm text-blue-600 underline mr-4 hover:text-blue-800"
                >Export as {{ format.toUpperCase() }}</a
              >
            </div>
          </div>

          <!-- Delete user -->
          <div
            class="bg-white shadow py-5 px-6 mt-3 
              select-none cursor-pointer hover:bg-gray-200"
            @click="deleteChat"
          >
            <div class="text-left flex items-center">
              <i class="material-icons text-red-600" style="font-size: 28px;"
                >delete</i
              >
              <p class="text-red-600 text-lg mx-3">Delete chat</p>
            </div>
            <p v-if="error" class="text-sm text-red-500 mt-2">* {{ error }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { colorOffsets, getHash } from "@/global/variables.js";

export default {
  props: ["rightSidenav"],
  data() {
    return {
      barHeight: 40,
      activityLoaded: false,
      error: "",
      // What the export endpoint speaks. Kept next to the links rather than in
      // the store: this is a list of two strings, not application state.
      exportFormats: ["csv", "json"]
    };
  },
  watch: {
    // This is what `getActivity` already does for the chart one field up, and
    // what it was fixed for: switching rooms rebinds the whole panel in place
    // -- the same open panel, now showing someone else -- so anything on it
    // that does not belong to the room currently shown is being read as a
    // claim about the new room. `getActivity` guards the bars on `room_id` and
    // `activityLoaded` is reset on open; this message was the one thing left
    // unguarded, so "The chat could not be deleted." followed you from Bob's
    // chat to Carol's.
    //
    // On the room *id*, not on `getRoom`. `SET_ROOMS` does
    // `Vue.set(state.rooms, element.id, element)`, so every `fetchRooms`
    // replaces each room's entry with a fresh object literal - and `App.vue`
    // dispatches `fetchRooms` on any `update_rooms` push. A watcher on `getRoom`
    // therefore sees a new object identity for the *same* room, fires, and takes
    // the message down mid-attempt. The id changes only when the user actually
    // picks another chat, which is the only thing this should react to.
    roomId() {
      this.error = "";
    },
    // The component is always mounted -- rightSidenav only slides it in --
    // so opening the profile is a prop flip, not a mount.
    rightSidenav(open) {
      if (!open || !this.getRoom.id) return;
      this.activityLoaded = false;
      this.$store
        .dispatch("fetchRoomActivity", this.getRoom.id)
        // Only a request that came back sets `activityLoaded`: it gates the
        // "no messages yet" line, and a failed one must not claim the room is
        // empty. Stale data can't show either -- getActivity matches on room_id.
        .then(() => {
          this.activityLoaded = true;
        })
        .catch(() => {});
    }
  },
  methods: {
    exportUrl(format) {
      // The raw selected id, not `getRoom.id`. They are the same room -- the
      // app already leans on that invariant unguarded, at MessagesSection:25's
      // `state.rooms[selectedRoom].group_name` -- but this needs no lookup
      // through the rooms map to get it, and reading the selection is also what
      // makes the href follow the slide-over rebinding in place.
      return `/api/v1/rooms/${this.roomId}/export?as=${format}`;
    },
    deleteChat() {
      const roomId = this.getRoom.id;
      // Both side effects moved into the success path. They used to run
      // synchronously on click, before the server had been asked at all, so a
      // delete that failed was completely invisible: the chat closed, the panel
      // slid away, the room stayed in the sidebar, and nothing said so. The
      // close is the part that had to move - the panel is where any message
      // would be rendered, so closing it on click made the failure
      // unreportable, not merely unreported. Nothing needs undoing on failure:
      // the room is still there and still clickable.
      // Returned, not just fired: a method that starts a promise and hands back
      // undefined can be neither awaited nor tested, and this one has two side
      // effects hanging off the resolution.
      return this.$store
        .dispatch("deleteRoom", roomId)
        .then(() => {
          this.error = "";
          this.$store.commit("SET_SELECTED_ROOM", null);
          this.$emit("toggleRightSidenav");
        })
        .catch(() => {
          this.error = "The chat could not be deleted. Please try again.";
        });
    }
  },
  computed: {
    width() {
      return this.$store.state.width;
    },
    roomId() {
      return this.$store.state.selectedRoom;
    },
    getRoom() {
      let roomId = this.$store.state.selectedRoom;
      return this.$store.state.rooms[roomId] || {};
    },
    getActivity() {
      // Matched on room_id, not just on "something is loaded": switching rooms
      // faster than the request returns would otherwise draw the previous
      // room's bars under the new room's name.
      const activity = this.$store.state.roomActivity;
      if (!activity || activity.room_id !== this.getRoom.id) return null;
      return activity.peak ? activity : null;
    },
    getBars() {
      // One bar per entry, and the viewBox is as wide as the series, so
      // changing ACTIVITY_DAYS on the backend cannot silently misalign it.
      const activity = this.getActivity;
      if (!activity) return [];
      return activity.per_day.map(row => ({
        ...row,
        h: (row.count / activity.peak) * this.barHeight
      }));
    },
    getGroupProfile() {
      return this.getRoom.group_profile || {};
    },
    getAvatarName() {
      return this.getGroupProfile.username
        ? this.getGroupProfile.username.charAt(0).toUpperCase()
        : "";
    },
    getUsername() {
      return this.getGroupProfile ? this.getGroupProfile.username : "";
    },
    getUserTagline() {
      return this.getGroupProfile ? this.getGroupProfile.tagline : "";
    },
    getColor() {
      let username = this.getGroupProfile.username || "";
      let { red, green, blue } = colorOffsets;
      red = (getHash(username) + red) ** 2 % 256;
      green = (getHash(username) + green) ** 2 % 256;
      blue = (getHash(username) + blue) ** 2 % 256;
      return {
        red,
        green,
        blue
      };
    }
  }
};
</script>

<style scoped>
.closebtn {
  font-size: 36px;
}

.activity {
  width: 100%;
  height: 40px;
  fill: #38b2ac;
}

.avatar-main-circle {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  font-size: 130px;
  color: #fff;
  line-height: 180px;
  text-align: center;
  font-weight: 600;
}
</style>
