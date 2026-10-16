<template>
  <div class="circle-progress">
    <svg :width="size" :height="size" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle class="background-circle" cx="50" cy="50" :r="radius" fill="none" stroke="#e0e0e0"
        :stroke-width="strokeWidth" />
      <circle class="progress-circle" cx="50" cy="50" :r="radius" fill="none" stroke="#007bff"
        :stroke-width="strokeWidth" :stroke-dasharray="dashArray"
        :stroke-dashoffset="dashOffset < dashArray * 0.05 ? dashArray * 0.05 : dashOffset" />
    </svg>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "CircleProgress",
  props: {
    percent: {
      type: Number,
      required: true,
      validator: (value: number) => value >= 0 && value <= 1,
    },
    size: {
      type: Number,
      default: 14,
    },
    strokeWidth: {
      type: Number,
      default: 10,
    },
  },
  setup(props) {
    const radius = computed(() => props.size * 2 + props.strokeWidth);
    const dashArray = computed(() => 2 * Math.PI * radius.value);
    const dashOffset = computed(() => dashArray.value * (1 - props.percent));
    const percentageText = computed(() => `${Math.round(props.percent * 100)}%`);

    return {
      radius,
      dashArray,
      dashOffset,
      percentageText,
    };
  },
});
</script>

<style scoped>
.circle-progress {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.1px;
}

svg {
  transform: rotate(-90deg);
  transform-origin: center;
}

.background-circle {
  stroke: #e0e0e0;
}

.progress-circle {
  stroke: #007bff;
  transition: stroke-dashoffset 0.3s ease;
}

.percentage {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 16px;
  font-weight: bold;
  color: #333;
}
</style>
