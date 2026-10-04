<template>
  <div class="flex">
    <div class="sent-message ml-auto max-w-md">
      <div class="shadow-md border rounded-lg mx-2 my-1 px-4 bg-green-200">
        <!-- Message body -->
        <div class="mt-1">
          <p class="text-right">{{ message.body }}</p>
        </div>

        <!-- Time data -->
        <div class="flex justify-end mb-1">
          <p class="text-xs text-gray-600">{{ time }}</p>

          <!-- Sending icons -->
          <i
            v-if="message.sending"
            class="material-icons ml-2"
            style="font-size: 16px;"
            >access_time</i
          >
          <i
            v-if="
              allReceived[this.message.id] || this.message.all_received || false
            "
            class="material-icons ml-2"
            :class="{
              'font-bold text-teal-400':
                allRead[this.message.id] || this.message.all_read || false
            }"
            style="font-size: 16px;"
            >done_all</i
          >
          <i
            v-if="
              !message.sending &&
                !(
                  allReceived[this.message.id] ||
                  this.message.all_received ||
                  false
                )
            "
            class="material-icons ml-2"
            style="font-size: 16px;"
            >done</i
          >

          <!-- Delete. Absent on a message that has not reached the server yet:
               `message.sending` is exactly that, so `id` is `undefined` and
               `POST /api/v1/messages/undefined/delete` would 404 -- a control
               that can only ever report failure. A `button` carrying the same
               `material-icons` class as the read receipts above rather than a
               new glyph, and `text-gray-400` so it sits back until it is
               approached, at which point it goes red.

               **Always visible, deliberately.** `group-hover:opacity-100` was
               the first attempt and cannot work here on two counts, both
               measured: this build's `variants.opacity` is
               `["responsive", "hover", "focus"]`, so `group-hover` is never
               generated (the rebuild produced no `group-hover` rule at all, and
               the button would have stayed at `opacity-0` for everyone), and
               even enabled, a control that appears only on hover is unreachable
               by touch, where there is no hover. One grey icon on your own
               messages costs less than either. -->
          <button
            v-if="!message.sending"
            type="button"
            aria-label="Delete message"
            @click="deleteMessage()"
            class="material-icons ml-2 p-0 border-0 bg-transparent text-gray-400 hover:text-red-600 cursor-pointer"
            style="font-size: 16px;"
          >
            delete
          </button>
        </div>

        <!-- The last refusal. `ContactProfile.vue:134` shows the same for
             "Delete chat" and `MessagesSection.vue` for a failed search: a
             rejected delete that says nothing is indistinguishable from one
             that is still on its way. -->
        <p
          v-if="deleteError"
          role="alert"
          class="text-right text-xs text-red-600"
        >
          {{ deleteError }}
        </p>
      </div>
    </div>
  </div>
</template>

<script>
import dateFormat from "dateformat";

export default {
  props: {
    message: {
      type: Object,
      required: true
    }
  },
  data() {
    return {
      // Set only here, for the same reason as `MessagesSection`'s `searchError`:
      // `deleteMessage` rejects and a click handler has no caller to catch it,
      // so the refusal is both swallowed and invisible unless it is caught here
      // and shown.
      deleteError: ""
    };
  },
  computed: {
    time() {
      let time = dateFormat(new Date(this.message.timestamp), "hh:MM");
      return time;
    },
    allReceived() {
      return this.$store.state.allReceived;
    },
    allRead() {
      return this.$store.state.allRead;
    }
  },
  methods: {
    deleteMessage() {
      // Cleared up front rather than on success, so a retry replaces the
      // previous refusal instead of stacking on a stale one.
      this.deleteError = "";
      // Nothing is taken off the bubble here. The server announces the delete to
      // every participant including the sender, so the `message_delete` push is
      // what removes it -- one path for both sides, and no optimistic copy to
      // put back when the request is refused.
      this.$store.dispatch("deleteMessage", this.message.id).catch(() => {
        this.deleteError = "This message could not be deleted.";
      });
    },
    markMessageAsRead() {
      setTimeout(() => {
        // Timeout to avoid race condition with markRoomAsRead
        if (this.message.id in this.$store.state.unreadMessages) {
          this.$store.dispatch("markMessageAsRead", this.message.id);
        }
      }, 100);
    }
  },
  created() {
    this.markMessageAsRead();
  }
};
</script>
