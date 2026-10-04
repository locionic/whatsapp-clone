<template>
  <div class="success-alert">
    <div
      class="rounded-b px-4 py-3 shadow-md border-t-4"
      :class="
        error
          ? 'bg-red-100 border-red-500 text-red-900'
          : 'bg-teal-100 border-teal-500 text-teal-900'
      "
      role="alert"
    >
      <div class="flex">
        <div class="py-1">
          <svg
            class="fill-current h-6 w-6 mr-4"
            :class="error ? 'text-red-500' : 'text-teal-500'"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
          >
            <path
              d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zm12.73-1.41A8 8 0 1 0 4.34 4.34a8 8 0 0 0 11.32 11.32zM9 11V9h2v6H9v-4zm0-6h2v2H9V5z"
            />
          </svg>
        </div>
        <div>
          <p class="font-bold">Profile Update</p>
          <p class="text-sm">
            {{
              error
                ? "Your profile was not saved. Try again."
                : "Profile changes have been successfully updated."
            }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
// One flag, not two components: the banner is the same shape either way and it
// is only ever shown by UserProfile. It is also the only place a failed save
// could have been reported at all -- the save used to be caught and logged, so
// a rejected patch said nothing and the user believed their bio was stored.
export default {
  name: "SuccessAlert",
  props: {
    error: {
      type: Boolean,
      default: false
    }
  }
};
</script>
