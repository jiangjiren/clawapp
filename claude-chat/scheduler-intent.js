const DISCUSSION_RE = /怎么|如何|为什么|为何|是否|是不是|能否|可否|要不要|需不需要|合不合理|是否合理|是否合适|是什么意思|需要改|怎么改/;
const EXPLICIT_REMINDER_RE = /(?:提醒|通知)我|(?:设置|创建|新增|安排)(?:一个|个|一下)?(?:定时|提醒)(?:任务|计划|事项)?|(?:定时|按时)(?:提醒|通知|发送|推送|执行|运行|检查|生成|整理|汇总|备份|同步|发布)/;
const EXPLICIT_TASK_CONTROL_RE = /(?:查看|列出|取消|删除|暂停|恢复|启用|关闭).{0,8}(?:定时任务|提醒任务|提醒计划)/;
const SHORT_TASK_CONTROL_RE = /^(?:请|帮我|麻烦)?\s*(?:查看|列出|取消|删除|暂停|恢复)(?:一下|下)?(?:我的|当前|全部|所有)?任务(?:列表)?[。！？!?]*$/;
const RELATIVE_TIME_RE = /(?:\d+(?:\.\d+)?\s*(?:分钟|小时|天)后|一会儿|稍后|稍候|等会(?:儿)?|今天|今晚|明天|明早|后天|下周(?:一|二|三|四|五|六|日|天)?|周(?:一|二|三|四|五|六|日|天)|星期(?:一|二|三|四|五|六|日|天)|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*(?:点|[:：])\s*\d{0,2})/;
const RECURRING_TIME_RE = /(?:每天|每日|每周|每月|每年|每小时|每隔\s*\d*\s*(?:分钟|小时|天|周|月)|工作日)/;
const SCHEDULE_ACTION_RE = /(?:提醒|通知|发送|推送|执行|运行|检查|生成|整理|汇总|备份|同步|发布|启动|关闭|打开|更新)/;
// 保留 main 的任务排障入口，但不要让普通文章里的“没生效”也切换路由。
const TASK_FAILURE_RE = /(?:没|没有|未)(?:收到|推送|提醒|执行|生效)|不生效/;
const TASK_CONTEXT_RE = /定时|提醒|推送|任务/;
const SHORT_DELIVERY_FAILURE_RE = /^(?:(?:我|还是|仍然)\s*)*(?:没|没有|未)收到[。！？!?]*$/;

export function hasSchedulerIntent(value) {
  const text = String(value || "").trim();
  if (!text) return false;

  if (EXPLICIT_TASK_CONTROL_RE.test(text) || SHORT_TASK_CONTROL_RE.test(text)) return true;
  if (/^(?:(?:请|帮我)?(?:有哪些|列出|查看|查)(?:一下)?(?:我的|当前|全部|所有)?(?:定时|提醒)?任务(?:列表)?|任务列表)[。！？!?]*$/.test(text)) return true;
  if ((TASK_FAILURE_RE.test(text) && TASK_CONTEXT_RE.test(text)) || SHORT_DELIVERY_FAILURE_RE.test(text)) return true;
  if (DISCUSSION_RE.test(text)) return false;
  if (EXPLICIT_REMINDER_RE.test(text)) return true;

  const hasTime = RELATIVE_TIME_RE.test(text) || RECURRING_TIME_RE.test(text);
  return hasTime && SCHEDULE_ACTION_RE.test(text);
}

export function schedulerIntentText(message = {}) {
  if (typeof message.composerText === "string") {
    return message.composerText;
  }
  if (typeof message.displayText === "string" && message.displayText.trim()) {
    return message.displayText;
  }
  return String(message.prompt || "");
}

export function hasSchedulerIntentForMessage(message) {
  return hasSchedulerIntent(schedulerIntentText(message));
}
