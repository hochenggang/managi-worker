<template>
  <button @click="handleClick" :disabled="isLoading">
    <Transition name="btn-spinner" mode="out-in">
      <componentSpinner v-if="isLoading" key="spinner" :size="props.size" :thicknesses="props.thicknesses" />
      <span v-else key="content" class="btn-content">
        <slot></slot>
      </span>
    </Transition>
  </button>
</template>

<style scoped>
button {
  display: flex;
  justify-content: center;
  align-items: center;
  line-height: 1.25;
}

/* spinner/content 切换：淡入淡出 + 轻微缩放 */
.btn-spinner-enter-active,
.btn-spinner-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.btn-spinner-enter-from {
  opacity: 0;
  transform: scale(0.85);
}

.btn-spinner-leave-to {
  opacity: 0;
  transform: scale(0.85);
}

.btn-content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>

<script lang="ts" setup>
import { ref } from 'vue';
import componentSpinner from "@/components/Spinner.vue";
import { handleError, handleMsg } from "@/helper";

// 注意：action 参数为一个异步函数，点击后会尝试执行并 await ，action函数内需要进行reject(string 报错信息)或resolve(string 成功信息)处理
const props = defineProps({
  action: {
    type: Function,
    required: true,
  },
  size: {
    type: Number,
    default: 16,
  },
  thicknesses: {
    type: Number,
    default: 3,
  },
});


const isLoading = ref(false);

const handleClick = async () => {
  return new Promise(async (resolve, reject) => {
    // 验证 props.action 是否为函数
    if (typeof props.action !== 'function') {
      handleError(`props.action is not a function`);
      return;
    }
    isLoading.value = true;
    try {
      const sucess_message = await props.action()
      if (sucess_message) {
        handleMsg(sucess_message)
      }
    } catch (error) {
      // handleError 已放宽为 unknown，无需 as string 强转
      handleError(error)
    } finally {
      isLoading.value = false;
      resolve(null)
    }
  })
};
</script>
