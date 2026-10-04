<template>
  <div class="menu">
    <!-- Hover was the only way in, and this holds the only Logout in the app.
         `focusin` is what makes it a control rather than a hover target: the
         dropdown is `v-if`'d, so while it is closed the Logout link is not in
         the DOM to be tabbed to, and nothing that does not need a pointer can
         open it. On a touch device - where UsersSection:25 renders this as the
         *only* logout - a hover is not a gesture anyone has. -->
    <div
      class="mr-3 dropdown"
      @mouseover="showContext = true"
      @mouseleave="showContext = false"
      @focusin="showContext = true"
      @focusout="onFocusOut"
      @keydown.esc="showContext = false"
    >
      <button
        class="cursor-pointer dropbtn"
        aria-label="Account menu"
        aria-haspopup="true"
        :aria-expanded="showContext ? 'true' : 'false'"
      >
        <i class="material-icons text-2xl mx-1">more_vert</i>
      </button>
      <transition name="fade">
        <div class="dropdown-content rounded-lg" v-if="showContext">
          <a href="/accounts/logout/" class="flex rounded-lg">
            <i class="flex-1 material-icons mr-2">exit_to_app</i>
            <p class="flex-1">Logout</p>
          </a>
        </div>
      </transition>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      showContext: false
    };
  },
  methods: {
    // `focusout` fires for the button too, so closing on it would snap the menu
    // shut the moment you tab from the trigger onto the only link it contains -
    // a keyboard path that dies one step in. Close when focus leaves the menu,
    // not when it moves within it.
    onFocusOut(event) {
      if (!this.$el.contains(event.relatedTarget)) {
        this.showContext = false;
      }
    }
  }
};
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: all 0.3s;
}
.fade-enter,
.fade-leave-to {
  transform: translateY(10px);
  opacity: 0;
}

/* DROPDOWN */

/* Style The Dropdown Button */
.dropbtn {
  cursor: pointer;
}

/* The container <div> - needed to position the dropdown content */
.dropdown {
  position: relative;
  display: inline-block;
}

/* Dropdown Content (Hidden by Default) */
.dropdown-content {
  position: absolute;
  background-color: #e6fffa;
  box-shadow: 0px 8px 16px 0px rgba(0, 0, 0, 0.2);
  z-index: 1;
  right: 0;
}

/* Links inside the dropdown */
.dropdown-content a {
  color: black;
  padding: 12px 16px;
  text-decoration: none;
}

/* Change color of dropdown links on hover */
.dropdown-content a:hover {
  background-color: #b2f5ea;
}
</style>