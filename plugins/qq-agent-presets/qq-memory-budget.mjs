// 整理会话没有 QQ 发送权限；输出上限设置在 AgentOptions，不能靠提示词约束。
export const name = 'qq-memory-budget';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '记忆整理会话不允许调用工具');
  ctx.on('agent/created', ({ agent }) => {
    try {
      agent.options.maxTokens = 1000;
      if (agent.options.maxTokens !== 1000) throw new Error('输出预算设置失败');
    } catch (error) {
      // 能力不兼容时阻止该会话继续工作，不能悄悄使用无限输出配置。
      agent.cancel({ kind: 'hook', reason: '记忆整理输出预算设置失败' });
      throw error;
    }
  });
}
