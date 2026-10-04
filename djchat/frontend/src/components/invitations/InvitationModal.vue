<template>
  <div class="invitation-modal">
    <card-modal class="px-3" :showing="showModal" @close="showModal = false">
      <div class="modal-header">
        <h2 class="text-xl font-bold text-gray-900">Add a Friend!</h2>
        <p class="mt-3">
          Enter his / her email and wait for their answer.
        </p>
      </div>

      <div class="modal-body mt-3">
        <div class="max-w-xs mx-auto">
          <div class="mb-4">
            <input
              class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
              id="email"
              type="email"
              placeholder="email"
              v-model="friendEmail"
            />
          </div>
          <p v-if="error" class="text-sm text-red-500">* {{ error }}</p>
        </div>
      </div>

      <div class="action-buttons mt-6">
        <button
          class="mx-3 bg-blue-600 text-white px-4 py-2 text-sm uppercase tracking-wide font-bold rounded-lg"
          @click="addFriend"
        >
          Send
        </button>

        <button
          class="mx-3 bg-blue-600 text-white px-4 py-2 text-sm uppercase tracking-wide font-bold rounded-lg"
          @click="showModal = false"
        >
          Close
        </button>
      </div>
    </card-modal>
  </div>
</template>

<script>
import CardModal from "@/components/Modal.vue";

export default {
  data() {
    return {
      showModal: false,
      friendEmail: "",
      error: ""
    };
  },
  components: {
    CardModal
  },
  methods: {
    async addFriend() {
      // Every attempt starts from nothing said. `this.error` is otherwise only
      // written inside a catch, and nothing ever clears it -- so the first
      // failure of a session stayed under the input for the rest of it,
      // describing an address and a lookup that no longer existed. Clearing
      // here rather than on failure is the point: a stale message has to be
      // gone *before* the next attempt, not after it, or it sits on screen
      // while the user reads it as the answer to the Send they just pressed.
      this.error = "";
      let userId = null;
      try {
        let response = await this.$store.dispatch(
          "getUserIdFromEmail",
          this.friendEmail
        );
        userId = response.data.id;
      } catch (error) {
        // axios only sets `response` when the server actually replied. Anything
        // that stopped the request short of a reply -- server down, DNS failure,
        // connection refused, CORS -- leaves it undefined, and reading
        // `error.response.status` then throws a TypeError *inside this catch*:
        // no message reaches the modal, and the TypeError escapes the method as
        // an unhandled rejection. Verified against the installed axios 0.19.0 -
        // ECONNREFUSED gives `response === undefined`. No `?.` here: this is
        // webpack 4 on acorn 6, which cannot parse it.
        if (error.response && error.response.status === 404) {
          this.error = "User not found.";
        } else {
          this.error = "An error has occurred. Please try again later.";
        }
        return;
      }
      try {
        await this.$store.dispatch("addFriend", userId);
        // The address goes with it. `Home.vue:11` mounts this modal for the
        // whole session, so an address left in the field is the *next*
        // invitation's pre-filled value -- and Send on it comes back "You have
        // already sent an invitation." for someone who was never asked for.
        this.friendEmail = "";
        this.showModal = false;
      } catch (error) {
        // Same unguarded dereference, same reason -- and the status is no
        // longer enough to say what happened. Three different refusals all
        // answer 400: an invite already pending, the target already being a
        // friend, and the address being your own. One sentence covered all
        // three, so the last two told the user they had already sent an
        // invitation they had never sent. The reason is in the body; read it
        // there. No `?.` -- webpack 4 on acorn 6 cannot parse it.
        const response = error.response;
        const detail = response && response.data ? response.data.detail : null;
        this.error =
          (Array.isArray(detail) ? detail[0] : detail) ||
          "An error has occurred. Please try again later.";
        return;
      }
    },
    open() {
      // A fresh visit starts blank. `close()` deliberately does *not* clear
      // these: there is a Close button, and the overlay behind the modal
      // dismisses it too, so a half-typed address must survive a dismissal.
      // Only `open()` -- coming back to invite somebody -- and a successful send
      // put the form back to nothing.
      this.error = "";
      this.friendEmail = "";
      this.showModal = true;
    },
    close() {
      this.showModal = false;
    }
  }
};
</script>
