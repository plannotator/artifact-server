import {defineMessages} from "../locale.ts";

function threadsWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

function annotationCount(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

/**
 * Text in shared components: the comment composer, the send-to-agent
 * control and its undo toast, agent presence, and shadcn primitives.
 *
 * Copy pinned by project/spec/send-all-spec.md (`noAgentConnected`,
 * `nothingOpen`, `disconnectedPickAnother`, `queuedFor`, `sendWithNoteMenu`)
 * must stay word for word in English.
 */
export const componentsText = defineMessages({
  en: {
    comments: {
      draft: "Draft",
      discard: "Discard",
      placeholder: "Describe what should change and why.",
      tooLong: (maximum: number, over: number) =>
        `A comment holds at most ${maximum} characters. Remove ${over}.`,
      saving: "Saving…",
    },
    dispatch: {
      state: {
        addressed: "Addressed",
        canceled: "Canceled",
        claimed: "Claimed",
        delivered: "Delivered",
        failed: "Failed",
        queued: "Queued",
      },
      nothingOpen: "Nothing open to send.",
      disconnectedPickAnother: (name: string) => `${name} disconnected — pick another`,
      noAgentConnected: "No agent connected — connect one to send.",
      sending: "Sending…",
      chooseAgentOrNote: "Choose agent or send with a note",
      sendWithNoteMenu: "Send with a note…",
      sendWithNoteTitle: "Send with a note",
      sendWithNoteDescription:
        "The annotations in this send leave the open list when it succeeds. Undo can call them back while the agent has not completed the send.",
      readingAgents: "Reading connected agents…",
      connectedAgents: "Connected agents",
      connected: "Connected",
      notConnected: (lastSeen: string) => `Not connected, last seen ${lastSeen}`,
      noteLabel: "Note for the agent",
      notePlaceholder: "Optional context for the whole bundle.",
      noteTooLong: (maximum: number, over: number) =>
        `A note holds at most ${maximum} characters. Remove ${over}.`,
      cancel: "Cancel",
      sendCount: (count: number) => `Send ${annotationCount(count)}`,
      toast: {
        queuedFor: (name: string) => `Queued for ${name} — it picks this up when it next checks in.`,
        sent: (count: number, name: string) => `Sent ${threadsWord(count)} to ${name}`,
        sentPartially: (count: number, name: string, unsent: number) =>
          `Sent ${threadsWord(count)} to ${name}; ${threadsWord(unsent)} could not be sent.`,
        undone: "Send canceled — the annotations are back.",
        tooLate: (name: string) =>
          `Too late to undo — ${name} already carried this send past the point of cancelling.`,
        undo: "Undo",
        undoing: "Undoing…",
      },
    },
    presence: {
      ring: {
        disconnected: "Disconnected",
        idle: "Idle",
        replying: "Replying",
        working: "Working",
      },
      idleSentence: "Connected and idle — a send reaches it as one message.",
      workingSentence: (when: string) => `Working — took a bundle ${when}.`,
      replyingSentence: "Replying — writing back to the annotations it was sent.",
      disconnectedSentence: (lastSeen: string) =>
        `Not connected — last seen ${lastSeen}. Restart the agent in its working directory to reconnect.`,
      isReplying: (name: string) => `${name} is replying…`,
      isWorking: (name: string) => `${name} is working…`,
      avatarLabel: (name: string, state: string) => `${name} — ${state}`,
      agent: "Agent",
      lastSeen: "Last seen",
      workingDirectory: "Working directory",
    },
    ui: {
      close: "Close",
    },
  },
  "zh-TW": {
    comments: {
      draft: "草稿",
      discard: "捨棄",
      placeholder: "說明要改什麼、為什麼要改。",
      tooLong: (maximum: number, over: number) =>
        `留言最多 ${maximum} 個字元，目前多了 ${over} 個，刪減後再儲存。`,
      saving: "儲存中…",
    },
    dispatch: {
      state: {
        addressed: "已處理",
        canceled: "已取消",
        claimed: "已領取",
        delivered: "已送達",
        failed: "失敗",
        queued: "排隊中",
      },
      nothingOpen: "沒有未解決的留言可以傳送。",
      disconnectedPickAnother: (name: string) => `${name} 已中斷連線，改選其他 Agent`,
      noAgentConnected: "沒有已連線的 Agent，請先連線一個再傳送。",
      sending: "傳送中…",
      chooseAgentOrNote: "選擇 Agent 或附上備註傳送",
      sendWithNoteMenu: "附上備註傳送…",
      sendWithNoteTitle: "附上備註傳送",
      sendWithNoteDescription:
        "傳送成功後，這批標註會離開未解決清單。在 Agent 完成這次派工之前，都可以用「復原」收回。",
      readingAgents: "正在讀取已連線的 Agent…",
      connectedAgents: "已連線的 Agent",
      connected: "已連線",
      notConnected: (lastSeen: string) => `未連線，最後出現於 ${lastSeen}`,
      noteLabel: "給 Agent 的備註",
      notePlaceholder: "選填，給整批標註的補充說明。",
      noteTooLong: (maximum: number, over: number) =>
        `備註最多 ${maximum} 個字元，目前多了 ${over} 個，刪減後再傳送。`,
      cancel: "取消",
      sendCount: (count: number) => `傳送 ${count} 則標註`,
      toast: {
        queuedFor: (name: string) => `已排入 ${name} 的佇列，它下次報到時就會接手。`,
        sent: (count: number, name: string) => `已把 ${count} 則留言串交給 ${name}`,
        sentPartially: (count: number, name: string, unsent: number) =>
          `已把 ${count} 則留言串交給 ${name}，另有 ${unsent} 則沒能送出。`,
        undone: "已取消傳送，標註已放回清單。",
        tooLate: (name: string) =>
          `來不及復原：${name} 已經處理到無法取消的階段。`,
        undo: "復原",
        undoing: "復原中…",
      },
    },
    presence: {
      ring: {
        disconnected: "已中斷連線",
        idle: "閒置",
        replying: "回覆中",
        working: "工作中",
      },
      idleSentence: "已連線，目前閒置。送出的內容會以一則訊息送達。",
      workingSentence: (when: string) => `工作中，${when}領取了一批留言。`,
      replyingSentence: "回覆中，正在回覆交給它的標註。",
      disconnectedSentence: (lastSeen: string) =>
        `未連線，最後出現於 ${lastSeen}。在它的工作目錄重新啟動這個 Agent 就能重新連線。`,
      isReplying: (name: string) => `${name} 回覆中…`,
      isWorking: (name: string) => `${name} 工作中…`,
      avatarLabel: (name: string, state: string) => `${name}：${state}`,
      agent: "Agent",
      lastSeen: "最後出現",
      workingDirectory: "工作目錄",
    },
    ui: {
      close: "關閉",
    },
  },
});
