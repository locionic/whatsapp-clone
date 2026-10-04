<template>
  <div class="bg-white">
    <!-- Search Panel -->
    <div class="flex items-center search-panel border-b" style="height: 10vh">
      <!-- Avatar -->
      <button
        type="button"
        class="avatar-circle flex-none mx-3 select-none cursor-pointer hover:shadow-md p-0 bg-transparent border-0"
        :style="
          `background-color: rgb(${getColor.red},${getColor.green},${getColor.blue}); transition: box-shadow 0.3s;`
        "
        aria-label="Open your profile"
        @click="$emit('profile')"
      >
        {{ getAvatarName }}
      </button>

      <div class="flex-grow ">
        <search
          class="max-w-xs mx-auto pr-3"
          @updateSearch="currentSearch = $event"
        />
      </div>

      <!-- The only way into `NewGroupModal`, and the only way to make a group at
           all: `RoomViewSet.create` has been wired since the first commit and
           nothing in the app called it. A `div` with a click handler would be
           the house style here, and would leave it out of the tab order exactly
           like items 38 to 50 were. Named by its own text, so there is no
           aria-label to drift away from it. -->
      <button
        type="button"
        class="new-group-trigger mr-3 flex-none text-sm font-semibold text-teal-600 hover:text-teal-800"
        @click="$emit('group-action')"
      >
        New group
      </button>

      <Menu v-if="width < 768" />
    </div>

    <!-- Lista de usuarios -->
    <div class="scrollbar overflow-y-auto user-list" style="height: 50vh;">
      <transition-group>
        <div
          v-for="room in rooms"
          :key="room.id"
          role="button"
          tabindex="0"
          :aria-current="room.id === $store.state.selectedRoom"
          @click="selectRoom(room.id)"
          @keydown.enter.space.prevent="selectRoom(room.id)"
          class="user-row"
          v-show="checkIfRowInQueriedResults(room.id)"
        >
          <user
            :room="room"
            :isSelected="room.id === $store.state.selectedRoom"
            @whosWriting="$emit('whosWriting', $event)"
          />
        </div>
      </transition-group>

      <!-- Fallback message -->
      <invite-friend
        class="mt-8"
        v-if="!rooms.length"
        @invite-action="$emit('invite-action')"
      >
        <p>You have not added any friends yet.</p>
        <p>Say hello to a friend!</p>
      </invite-friend>
    </div>
  </div>
</template>

<script>
import Menu from "@/components/Menu.vue";
import User from "./User.vue";
import Search from "@/components/Search.vue";
import InviteFriend from "@/components/invitations/InviteFriend";

import { colorOffsets, getHash } from "@/global/variables.js";

export default {
  data() {
    return {
      users: [],
      currentSearch: ""
    };
  },
  components: {
    User,
    Menu,
    Search,
    InviteFriend
  },
  methods: {
    selectRoom(roomId) {
      this.$store.commit("SET_SELECTED_ROOM", roomId);
      this.$emit("selected-room");
    },
    getValues(obj) {
      return [obj.group_name];
    },
    checkIfRowInQueriedResults(id) {
      return this.queriedResults.indexOf(id) != -1;
    }
  },
  computed: {
    width() {
      return this.$store.state.width;
    },
    getUserProfile() {
      return this.$store.state.userProfile || {};
    },
    getAvatarName() {
      return this.getUserProfile.username
        ? this.getUserProfile.username.charAt(0).toUpperCase()
        : "";
    },
    getColor() {
      let username = this.getUserProfile.username || "";
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
    rooms() {
      let sortedRooms = Object.values(this.$store.state.rooms).sort((a, b) => {
        return new Date(b.last_activity) - new Date(a.last_activity);
      });
      return sortedRooms;
    },
    queriedResults() {
      var _this2 = this;
      let list = this.rooms;
      if (this.currentSearch == "") return list.map(row => row.id);
      let queriedResults = list.filter(row => {
        let value = _this2
          .getValues(row)
          .toString()
          .toLowerCase();
        return value.indexOf(_this2.currentSearch.toLowerCase()) != -1;
      });
      return queriedResults.map(row => row.id);
    }
  }
};
</script>

<style scoped>
.user-row {
  transition: all 0.5s;
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
