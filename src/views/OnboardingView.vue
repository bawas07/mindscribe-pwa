<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { completeOnboarding } from '../lib/db/settings'

const router = useRouter()

const isContinuing = ref(false)
const continueError = ref<string | null>(null)

async function continueToDashboard() {
  isContinuing.value = true
  continueError.value = null
  try {
    await completeOnboarding()
    router.push('/')
  } catch {
    continueError.value = 'Something went wrong saving your settings — please try again.'
  } finally {
    isContinuing.value = false
  }
}
</script>

<template>
  <!-- Frame 00 — Onboarding (docs/example-journal-first.html) -->
  <div class="onboard">
    <div class="app-title">mind<span class="title-dot">·</span>scribe</div>
    <div class="onboard-tagline">A quiet place to write, that writes back.</div>

    <div class="onboard-block">
      <div class="aside-eyebrow">What it is</div>
      <p>A private journal. Every word stays on this device — nothing is sent anywhere. When you're stuck, it offers a gentle nudge; over time, it remembers your patterns so it can meet you where you are.</p>
    </div>

    <div class="onboard-block isnt">
      <div class="aside-eyebrow">What it isn't</div>
      <p>Therapy, or a diagnosis. MindScribe is a writing companion, not a clinician — and not a replacement for real support. If it ever sounds like you might be in crisis, it will quietly point you to resources that can actually help.</p>
    </div>

    <p v-if="continueError" class="continue-error" role="alert">{{ continueError }}</p>

    <button
      class="btn btn-primary btn-full"
      :disabled="isContinuing"
      @click="continueToDashboard"
    >
      Continue
    </button>
  </div>
</template>

<style scoped>
/* Mirrors .onboard in the approved wireframe; tokens come from main.css. */
.onboard {
  display: flex;
  flex-direction: column;
  /* Fill the shell's content area so Continue anchors to the bottom. */
  min-height: calc(100dvh - var(--space-4) - 100px);
  /* Shell adds 24px sides; +8px = wireframe's 32px (--space-5) side padding. */
  padding: 0 var(--space-2);
  text-align: left;
}

.app-title {
  font-family: 'Fraunces', serif;
  font-size: 34px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: center;
  margin: 56px 0 8px;
}

.title-dot {
  color: var(--accent);
}

.onboard-tagline {
  font-family: 'Fraunces', serif;
  font-size: 15.5px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.6;
  margin-bottom: var(--space-5);
}

.onboard-block {
  margin-bottom: var(--space-4);
}

.onboard-block p {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--text);
  margin-top: 6px;
}

.aside-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--calm);
  margin-bottom: 2px;
}

.onboard-block.isnt .aside-eyebrow {
  color: var(--crisis);
}

.continue-error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--crisis);
  line-height: 1.6;
  margin-bottom: var(--space-4);
}

.btn {
  font-family: 'Work Sans', sans-serif;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius-sm);
  padding: 11px 18px;
  cursor: pointer;
  margin-top: auto;
  margin-bottom: var(--space-5);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn-primary {
  background: var(--accent);
  color: #1a1408;
}

.btn-full {
  width: 100%;
}
</style>
