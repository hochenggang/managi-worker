<template>
  <Modal @close="emits('close')">
    <main class="modal-content">

      <h2>{{ t("addNode.title") }}</h2>
      <form @submit.prevent="handleSubmit">
        <label>
          {{ t("addNode.name") }}
          <input v-model="newNode.name" :placeholder="t('addNode.namePlaceholder')" required />
        </label>
        <label>
          {{ t("addNode.host") }}
          <input v-model="newNode.host" :placeholder="t('addNode.hostPlaceholder')" required />
        </label>
        <label>
          {{ t("addNode.port") }}
          <input v-model="newNode.port" type="number" min="1" max="65535" :placeholder="t('addNode.portPlaceholder')" required />
        </label>
        <label>
          {{ t("addNode.username") }}
          <input v-model="newNode.username" :placeholder="t('addNode.usernamePlaceholder')" required />
        </label>
        <label>
          {{ t("addNode.authType") }}
          <select v-model="newNode.auth_type" required>
            <option value="password">{{ t("addNode.authTypePassword") }}</option>
            <option value="key">{{ t("addNode.authTypePrivateKey") }}</option>
          </select>
        </label>
        <label>
          {{ t("addNode.authValue") }}

          <textarea v-model="newNode.auth_value" placeholder="" required></textarea>
        </label>
        <label>
          {{ t('addNode.group') }}
          <input v-model="newNode.group" :placeholder="t('addNode.groupPlaceholder')" />
        </label>
        <button class="sucess" type="submit">{{ t("addNode.actions.save") }}</button>
        <button type="button" @click="$emit('close')">{{ t("addNode.actions.cancel") }}</button>
      </form>

    </main>
  </Modal>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import Modal from "@/components/Modal.vue";
import type { ApiNode } from '@/protocol/types';
import { useI18n } from 'vue-i18n'
import { handleError } from '@/helper'

const { t } = useI18n({
  inheritLocale: true,
  useScope: 'global'
})


const emits = defineEmits(['addNode', 'close']);
const props = defineProps({
  node: {
    type: Object as () => ApiNode,
    default: () => ({
      name: '',
      host: '',
      port: 22,
      username: 'root',
      auth_type: 'password' as const,
      auth_value: '',
      group: '',
    })
  }
});

// 浅拷贝 props.node 为可编辑本地副本，避免 v-model 修改父组件数据。
// ApiNode 为扁平结构（仅原始类型），浅拷贝即等价深拷贝；
// 且 props.node 是 Vue reactive proxy，structuredClone 无法克隆 Proxy 会抛 DataCloneError。
const newNode = ref<ApiNode>({ ...props.node });

const handleSubmit = () => {
  // 校验端口范围 1-65535
  const port = Number(newNode.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    handleError(t('addNode.invalidPort'))
    return
  }
  newNode.value.port = port
  emits('addNode', newNode.value);
};
</script>

<style scoped>
.modal-content {
  width: 25rem;
  padding: 2rem;
}

h2 {
  width: 100%;
  text-align: center;
  font-size: 1rem;
}

form {
  display: flex;
  flex-direction: column;
}


input,
select,
button {
  width: 100%;
  padding: 0.5rem;
  margin-bottom: 0.25rem;
  font-size: 0.8rem;
}

label {
  font-size: 0.7rem;
  color: #555;
}
</style>
