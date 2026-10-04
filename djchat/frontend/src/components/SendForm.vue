<template>
  <div
    class="send-form flex items-center border rounded-lg border-teal-500 shadow-md"
  >
    <textarea
      class="ml-3 text-lg appearance-none bg-transparent border-none w-full text-gray-700 mr-3 py-1 px-2 leading-tight focus:outline-none focus:shadow-outline resize-none overflow-hidden"
      rows="1"
      placeholder="Send a message"
      aria-label="Enter text"
      v-model="body"
      ref="inputText"
      :maxlength="maxBody"
      @keydown.enter.exact.prevent="sendMessage()"
    />
    <button
      class="flex-shrink-0 select-none bg-teal-500 hover:bg-teal-700 border-teal-500 hover:border-teal-700 text-sm border-4 text-white py-1 px-2 rounded"
      :class="{
        'cursor-not-allowed bg-teal-700 border-teal-700': !$store.state
          .selectedRoom
      }"
      type="button"
      style="transition: background-color 0.3s;"
      @click.prevent="sendMessage()"
    >
      <send-icon size="1.5x" class="custom-class inline-block"></send-icon>
      <p class="inline-block mx-3 text-lg">Send</p>
    </button>
  </div>
</template>

<script>
import uuid4 from "uuid4";

import { SendIcon } from "vue-feather-icons";
import { checkText } from "smile2emoji";

export default {
  data() {
    return {
      body: "",
      timerId: null,
      // chat.models.Message.body max_length. The server refuses more than this
      // -- DRF copies max_length off the TextField onto the serializer field --
      // and the input used to accept it anyway, so a message over the limit was
      // fully typable and could never be sent: the bubble blinked out, the text
      // came back, and nothing said why. Retrying failed identically forever.
      // The same fix the tagline already has; see UserProfile.vue.
      maxBody: 500
    };
  },
  components: {
    SendIcon
  },
  methods: {
    throttleFunction(fn, delay) {
      if (this.timerId) return;
      fn();
      this.timerId = setTimeout(() => {
        this.timerId = null;
      }, delay);
    },
    /**
     * Grow the composer to fit what is in it.
     *
     * `rows="1"` with no growth shows one line of a message the app will accept
     * 500 characters of, and scrolls the rest out of sight. Collapsing to
     * `auto` first is what makes this work at all: measuring `scrollHeight`
     * while the box is already tall reports the height it *was*, so the box can
     * shrink when a line is deleted but never recovers it.
     *
     * Called from the `body` watcher rather than from an `@input` handler, so
     * the three ways the body changes are covered once: typing, the clear after
     * a send, and the draft the room watcher throws away.
     */
    resize() {
      const box = this.$refs.inputText;
      if (!box) return;
      box.style.height = "auto";
      box.style.height = box.scrollHeight + "px";
    },
    sendMessage() {
      if (this.room && this.body.trim()) {
        this.timerId = null;
        this.body = checkText(this.body);
        let front_key = uuid4();
        let sendingMessage = {
          room: this.room,
          body: this.body,
          is_owner: true,
          sending: true,
          timestamp: new Date().toString(),
          front_key
        };
        this.$store.commit("LINK_MESSAGES_TO_ROOM", [sendingMessage]);
        this.$store.commit("ADD_MESSAGE_TO_SENDING", sendingMessage);
        this.$store
          .dispatch("sendMessage", {
            room: this.room,
            body: this.body,
            front_key
          })
          .catch(() => {
            // The store takes the failed bubble back down; this is the other
            // half, because the box was emptied the instant the send looked like
            // it had gone. Only if it is still empty -- a refusal takes a round
            // trip, and anything typed since is newer and wanted.
            //
            // And only if this is still the chat it was sent to. A refusal can
            // land after you have clicked to someone else, and the box is empty
            // by then (the send cleared it, and the watcher clears it again),
            // so the `!this.body` guard does not stop the text from arriving in
            // the wrong chat's box -- where the next Enter sends it there. The
            // trade is that an unsent message is lost rather than misdelivered;
            // per-room drafts would keep it, and that is a feature, not a fix.
            if (!this.body && this.room === sendingMessage.room) {
              this.body = sendingMessage.body;
            }
          });
        this.body = "";
        this.$refs["inputText"].focus();
      }
    }
  },
  computed: {
    room() {
      return this.$store.state.selectedRoom;
    }
  },
  watch: {
    body(newValue) {
      // After the DOM catches up, so the box measures the *new* content. A
      // one-row composer that stayed five rows tall for the rest of the
      // session after one long message would be its own kind of bug.
      this.$nextTick(this.resize);
      if (newValue != "" && this.room) {
        this.throttleFunction(
          () => this.$store.dispatch("postWriting", this.room),
          10000
        );
      }
    },
    room() {
      this.timerId = null;
      // The draft goes with the chat it was written in. There is one
      // SendForm for the whole session -- `Rooms.vue:22` mounts it with no
      // `:key` and no `v-if` -- and `sendMessage` reads `this.room`, which is
      // whatever `selectedRoom` says *now*. So a draft left behind when you
      // clicked away was posted to whoever you clicked on, in green, in their
      // thread, looking like it had been meant for them.
      this.body = "";
    }
  }
};
</script>
