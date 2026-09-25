import { type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { StateGraph, START, END } from '@langchain/langgraph'
import { AgentStateAnnotation, type AgentState } from './state.ts'
import { type AgentDependencies } from './deps.ts'
import { createNodes } from './nodes.ts'

/** Retry while attempts remain; otherwise stop. Never publish on a failure. */
const retryOrGiveUp = (state: AgentState) =>
  state.attemptNumber < state.maxAttempts ? 'diagnoseNode' : 'giveUpNode'

export const compileHealGraph = (
  deps: AgentDependencies,
  options?: { checkpointer?: BaseCheckpointSaver },
) => {
  const nodes = createNodes(deps)

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('retrieveNode', nodes.retrieveNode)
    .addNode('diagnoseNode', nodes.diagnoseNode)
    .addNode('planNode', nodes.planNode)
    .addNode('patchNode', nodes.patchNode)
    .addNode('sandboxNode', nodes.sandboxNode)
    .addNode('openPrNode', nodes.openPrNode)
    .addNode('mergePrNode', nodes.mergePrNode)
    .addNode('giveUpNode', nodes.giveUpNode)

    .addEdge(START, 'retrieveNode')
    .addEdge('retrieveNode', 'diagnoseNode')
    .addEdge('diagnoseNode', 'planNode')
    .addEdge('planNode', 'patchNode')
    // A diff that would not apply never reaches the sandbox; it is one spent attempt.
    .addConditionalEdges('patchNode', (state: AgentState) =>
      state.status === 'diagnosing' ? retryOrGiveUp(state) : 'sandboxNode',
    )
    .addConditionalEdges('sandboxNode', (state: AgentState) =>
      state.sandboxResult?.verdict === 'pass' ? 'openPrNode' : retryOrGiveUp(state),
    )
    .addEdge('openPrNode', 'mergePrNode')
    .addEdge('mergePrNode', END)
    .addEdge('giveUpNode', END)

  const checkpointer = options?.checkpointer
  if (checkpointer) {
    return graph.compile({ checkpointer })
  }
  return graph.compile()
}
