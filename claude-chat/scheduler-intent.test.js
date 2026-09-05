import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSchedulerIntent,
  hasSchedulerIntentForMessage,
  schedulerIntentText,
} from "./scheduler-intent.js";

test("scheduler intent recognizes explicit reminder and task-management requests", () => {
  for (const prompt of [
    "10 分钟后提醒我开会",
    "明天上午 9 点通知我提交报告",
    "每天早上 9 点生成日报",
    "每隔 2 小时检查一次服务",
    "设置一个定时任务，工作日提醒我打卡",
    "每天 9 点提醒我写文案",
    "查看我的提醒任务",
    "取消任务",
  ]) {
    assert.equal(hasSchedulerIntent(prompt), true, prompt);
  }
});

test("scheduler intent ignores ordinary product and document language", () => {
  for (const prompt of [
    "这篇文章主要是针对管理者看的，第四部分你就需要改什么吗",
    "这条自动化旅程需要怎么改",
    "交付项目的客户能否自动转为已认证会员",
    "工作日特价房的权益设计是否合理",
    "每月报表字段需要调整吗",
    "提醒文案是不是太强硬了",
    "查看任务引擎的设计",
  ]) {
    assert.equal(hasSchedulerIntent(prompt), false, prompt);
  }
});

test("scheduler troubleshooting remains available without matching ordinary failures", () => {
  for (const prompt of ["为什么今天的定时任务没执行", "怎么没推送提醒", "没有收到", "列出所有任务", "任务列表"]) {
    assert.equal(hasSchedulerIntent(prompt), true, prompt);
  }
  for (const prompt of ["这个 CSS 修改没有生效", "怎么设置一个定时任务", "查看任务引擎的设计"]) {
    assert.equal(hasSchedulerIntent(prompt), false, prompt);
  }
  assert.equal(hasSchedulerIntentForMessage({ composerText: "", prompt: "每天提醒我开会" }), false);
  assert.equal(hasSchedulerIntentForMessage({ displayText: "解释这段提醒文案", prompt: "每天提醒我开会" }), false);
  assert.equal(hasSchedulerIntentForMessage({ prompt: "10 分钟后提醒我开会" }), true);
});

test("scheduler intent uses the authored instruction instead of attached context", () => {
  const message = {
    composerText: "这篇文章主要是针对管理者看的，第四部分需要改什么吗",
    displayText: "这篇文章主要是针对管理者看的，第四部分需要改什么吗",
    prompt: [
      "用户引用了以下文段：",
      "五条自动化旅程；酒店工作日特价房；客户自动转为会员。",
      "这篇文章主要是针对管理者看的，第四部分需要改什么吗",
    ].join("\n\n"),
  };

  assert.equal(schedulerIntentText(message), message.composerText);
  assert.equal(hasSchedulerIntentForMessage(message), false);
  assert.equal(hasSchedulerIntent(message.prompt), false, "article language alone must remain non-actionable");
});

test("legacy clients prefer visible text over context-expanded prompt", () => {
  const message = {
    displayText: "第四部分需要改什么吗",
    prompt: "引用：每天自动生成报告。\n\n第四部分需要改什么吗",
  };

  assert.equal(schedulerIntentText(message), message.displayText);
  assert.equal(hasSchedulerIntentForMessage(message), false);
});
