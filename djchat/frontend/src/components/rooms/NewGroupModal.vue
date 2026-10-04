<template>
  <div class="new-group-modal">
    <card-modal class="px-3" :showing="showModal" @close="showModal = false">
      <div class="modal-header">
        <h2 class="text-xl font-bold text-gray-900">New Group</h2>
        <p class="mt-3">Give it a name, then pick who is in it.</p>
      </div>

      <div class="modal-body mt-3">
        <div class="max-w-xs mx-auto">
          <div class="mb-4">
            <label
              class="block text-left text-sm text-teal-500"
              for="group-name"
              >Group name</label
            >
            <input
              class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
              id="group-name"
              type="text"
              placeholder="Weekend trip"
              :maxlength="maxGroupName"
              v-model="groupName"
            />
          </div>

          <fieldset>
            <legend class="text-left text-sm text-teal-500">
              People you already chat with
            </legend>
            <div class="mt-1 max-h-40 overflow-y-auto">
              <label
                v-for="user in candidates"
                :key="user.id"
                class="flex items-center cursor-pointer py-1"
              >
                <input
                  class="mr-2"
                  type="checkbox"
                  :value="user.id"
                  v-model="selected"
                />
                {{ user.username }}
              </label>
            </div>
            <p v-if="!candidates.length" class="text-left text-sm text-gray-500 mt-1">
              You have not exchanged any messages yet, so there is nobody to
              add.
            </p>
          </fieldset>

          <p v-if="error" class="text-sm text-red-500 mt-2">* {{ error }}</p>
        </div>
      </div>

      <div class="action-buttons mt-6">
        <button
          class="mx-3 bg-blue-600 text-white px-4 py-2 text-sm uppercase tracking-wide font-bold rounded-lg"
          @click="create"
        >
          Create
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

const GENERIC = "An error has occurred. Please try again later.";

export default {
  data() {
    return {
      showModal: false,
      groupName: "",
      selected: [],
      error: "",
      // chat.models.Room.group_name max_length. The server refuses more than
      // this, so an input that accepted it would let a name be typed that can
      // never be submitted. The same treatment SendForm.maxBody and
      // UserProfile's tagline already have.
      maxGroupName: 255
    };
  },
  components: {
    CardModal
  },
  computed: {
    // `state.users` and nothing else, and that is a limit of the app rather than
    // a choice: `UsersAPIView` requires `?email=` and answers with exactly one
    // account, deliberately without `tagline`, so there is no list of people to
    // offer. `state.users` is everyone the app has actually seen -- which is to
    // say everyone whose messages are in a room I am in.
    candidates() {
      let me = (this.$store.state.userProfile || {}).id;
      return Object.values(this.$store.state.users)
        // Sorted, because `state.users` is keyed by id in insertion order, which
        // is arrival order - a picker that reshuffles between visits is one
        // people tick the wrong row in.
        //
        // Minus me: my own messages carry my id, and offering yourself as
        // someone to add is a row that cannot fail. `RoomViewSet.create`
        // tolerates it, which is why nothing downstream would have complained.
        .filter(user => user.id !== me)
        .sort((a, b) => a.username.localeCompare(b.username));
    }
  },
  methods: {
    create() {
      // Every attempt starts from nothing said, for `InvitationModal`'s reason:
      // `error` is otherwise only ever written inside a catch, so the last
      // failure stays under the inputs describing a group that no longer exists
      // - and reads as the answer to the Create just pressed.
      this.error = "";
      // No name check and no "at least one other person" check here. The server
      // answers both with a sentence ("Group rooms must have a name.", "There
      // must be at least one another participant."), which this renders as-is;
      // mirroring the rules would mean two places to keep in step with
      // `RoomViewSet.create` and no better message than the one already there.
      return this.$store
        .dispatch("createGroup", {
          group_name: this.groupName,
          participants: this.selected
        })
        .then(() => {
          // Nothing to refresh. `RoomViewSet.create` already pushes
          // `update_rooms`, which `App.vue` answers with `fetchRooms`, so the
          // group arrives in the room list on its own.
          this.groupName = "";
          this.selected = [];
          this.showModal = false;
        })
        .catch(error => {
          // A failure keeps the name and the ticks: they are the only thing the
          // user cannot retype quickly, and closing here would make the
          // explanation unreportable as well as the form. `error.response` is
          // undefined for anything that stopped the request short of a reply, so
          // it is read through - no `?.`, this is webpack 4 on acorn 6.
          const response = error.response;
          const detail = response && response.data ? response.data.detail : null;
          this.error = (Array.isArray(detail) ? detail[0] : detail) || GENERIC;
        });
    },
    open() {
      // A fresh visit starts blank. `close()` deliberately does not clear
      // these: there is a Close button and the overlay behind the modal
      // dismisses it too, so a half-typed name has to survive a dismissal. Only
      // `open()` and a successful create put the form back to nothing -
      // `Home.vue` mounts this for the whole session, so a name left behind
      // would be the next group's pre-filled value.
      this.error = "";
      this.groupName = "";
      this.selected = [];
      this.showModal = true;
    },
    close() {
      this.showModal = false;
    }
  }
};
</script>