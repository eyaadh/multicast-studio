<script setup lang="ts">
import { computed, ref } from 'vue'
import { Combobox, ComboboxButton, ComboboxInput, ComboboxLabel, ComboboxOption, ComboboxOptions } from '@headlessui/vue'
import { Check, ChevronDown } from 'lucide-vue-next'

type ChoiceValue = string | number | null
type Choice = { value: ChoiceValue; label: string; description?: string; disabled?: boolean }

const props = withDefaults(defineProps<{
  modelValue: ChoiceValue
  options: Choice[]
  label: string
  placeholder?: string
  disabled?: boolean
}>(), { placeholder: 'Search or select…', disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: ChoiceValue] }>()
const query = ref('')
const selected = computed({
  get: () => props.modelValue,
  set: (value: ChoiceValue) => { emit('update:modelValue', value); query.value = '' },
})
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return search ? props.options.filter(option => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(search)) : props.options
})
function displayValue(value: unknown): string {
  return props.options.find(option => option.value === value)?.label || ''
}
</script>

<template>
  <Combobox v-model="selected" as="div" :disabled="disabled" class="min-w-0">
    <ComboboxLabel class="field-label">{{ label }}</ComboboxLabel>
    <div class="relative">
      <ComboboxInput
        class="field pr-11"
        :display-value="displayValue"
        :placeholder="placeholder"
        autocomplete="off"
        @change="query = ($event.target as HTMLInputElement).value"
        @blur="query = ''"
      />
      <ComboboxButton class="absolute inset-y-0 right-0 flex items-center rounded-r-xl px-3 text-zinc-500 hover:text-emerald-600 dark:text-zinc-400 dark:hover:text-emerald-400 focus:outline-none" :aria-label="`Show ${label} options`">
        <ChevronDown :size="17" aria-hidden="true" />
      </ComboboxButton>
      <transition leave-active-class="transition ease-in duration-100" leave-from-class="opacity-100" leave-to-class="opacity-0">
        <ComboboxOptions class="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-zinc-200 bg-white py-1 text-sm shadow-xl shadow-zinc-900/10 dark:border-white/10 dark:bg-zinc-900 dark:shadow-black/50 focus:outline-none">
          <div v-if="!filtered.length" class="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400">No matching options</div>
          <ComboboxOption v-for="option in filtered" :key="String(option.value)" :value="option.value" :disabled="option.disabled" as="template" v-slot="{ active, selected: isSelected, disabled: isDisabled }">
            <li :class="['relative flex cursor-pointer items-center gap-2 px-3 py-2.5', active ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950' : 'text-zinc-900 dark:text-zinc-100', isDisabled ? 'opacity-40' : '']">
              <span class="min-w-0 flex-1"><span class="block truncate font-medium">{{ option.label }}</span><span v-if="option.description" class="block truncate text-xs opacity-70">{{ option.description }}</span></span>
              <Check v-if="isSelected" :size="16" class="shrink-0" aria-hidden="true" />
            </li>
          </ComboboxOption>
        </ComboboxOptions>
      </transition>
    </div>
  </Combobox>
</template>
