<template>
  <div class="user-profile">
    <!-- Left Sidenavs -->
    <div
      class="absolute my-profile-sidenav bg-gray-200"
      :style="
        `height: 100%; width: 100%; z-index:10; 
            transform: translate(-${leftSidenav ? 0 : 150}%);
            transition: transform 0.5s ease-out;`
      "
    >
      <div class=" w-full">
        <div
          class="flex justify-between items-center px-5 bg-teal-500"
          style="height: 10vh;"
        >
          <!-- Header -->
          <div>
            <p class="text-white text-left text-xl">My Profile</p>
          </div>

          <!-- Close Button -->
          <button
            aria-label="close"
            class="text-xl text-white closebtn"
            @click.prevent="$emit('toggleLeftSidenav')"
          >
            ×
          </button>
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
              <p class="text-lg capitalize">{{ getUsername }}</p>
            </div>
          </div>

          <!-- Description -->
          <form class="bg-white shadow py-3 px-6 mt-3">
            <p class="text-left text-sm text-teal-500">Description</p>
            <div
              class="flex items-center border-b border-b-2 border-teal-500 py-2"
            >
              <!-- Tagline textarea -->
              <textarea
                class="appearance-none bg-transparent border-none w-full text-gray-700 mr-3 py-1 px-2 leading-tight focus:outline-none focus:shadow-outline"
                type="text"
                placeholder="Add some info."
                aria-label="Description"
                rows="3"
                v-model="tagline"
                :disabled="isPatching"
                :maxlength="maxTagline"
              ></textarea>

              <!-- Save button -->
              <button
                class="flex-shrink-0 text-sm border-4 text-white py-1 px-2 rounded"
                :class="{
                  'bg-teal-500 hover:bg-teal-700 border-teal-500 hover:border-teal-700': !isPatching,
                  'bg-gray-500': isPatching
                }"
                type="button"
                :disabled="isPatching"
                :maxlength="maxTagline"
                @click="patchUserProfile"
              >
                Save
              </button>
            </div>
          </form>

          <!-- One chain, not two v-ifs: a <transition> takes a single child. -->
          <transition name="fade">
            <success-alert v-if="showSuccess" class="m-3" />
            <success-alert v-else-if="showError" class="m-3" :error="true" />
          </transition>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import SuccessAlert from "./SuccessAlert";
import { colorOffsets, getHash } from "@/global/variables.js";

export default {
  components: {
    SuccessAlert
  },
  data() {
    return {
      tagline: "",
      isPatching: false,
      showSuccess: false,
      showError: false,
      // users.models.CustomUser.tagline max_length. The server rejects more
      // than this, and the textarea used to accept it silently -- so a paste
      // over the limit came back as a 400 that nothing displayed, and the
      // user's bio looked saved while the old one stayed put.
      maxTagline: 1024
    };
  },
  props: {
    leftSidenav: {
      type: Boolean,
      required: true
    }
  },
  methods: {
    async patchUserProfile() {
      this.isPatching = true;
      try {
        await this.$store.dispatch("patchUserProfile", {
          tagline: this.tagline
        });
        this.showSuccessAlert();
      } catch (error) {
        // Was a bare console.log, so a rejected save said nothing at all: the
        // button re-enabled, no alert, and the text the user just wrote stayed
        // in the box looking like it had been kept.
        this.showErrorAlert();
      }
      this.isPatching = false;
    },
    showSuccessAlert() {
      this.showSuccess = true;
      this.showError = false;
      setTimeout(() => {
        this.showSuccess = false;
      }, 5000);
    },
    showErrorAlert() {
      this.showError = true;
      this.showSuccess = false;
      setTimeout(() => {
        this.showError = false;
      }, 5000);
    }
  },
  computed: {
    getUserProfile() {
      return this.$store.state.userProfile || {};
    },
    getAvatarName() {
      return this.getUserProfile.username
        ? this.getUserProfile.username.charAt(0).toUpperCase()
        : "";
    },
    getUsername() {
      return this.$store.state.userProfile
        ? this.$store.state.userProfile.username
        : "";
    },
    getUserTagline() {
      return this.$store.state.userProfile
        ? this.$store.state.userProfile.tagline
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
    }
  },
  watch: {
    getUserTagline: function(value) {
      this.tagline = value;
    },
    leftSidenav: function(value) {
      if (value) {
        this.tagline = this.getUserTagline;
      }
    }
  }
};
</script>

<style scoped>
.closebtn {
  font-size: 36px;
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

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s;
}
.fade-enter, .fade-leave-to /* .fade-leave-active below version 2.1.8 */ {
  opacity: 0;
}
</style>
