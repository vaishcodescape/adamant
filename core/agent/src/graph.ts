import { StateGraph, START, END } from '@langchain/langgraph'
import { AgentStateAnnotation, type AgentState } from './state.ts'
import { type AgentDependencies } from './deps.ts'
import { createNodes } from './nodes.ts'

export const compileHealGraph = (deps: AgentDependencies) => {
  const nodes = createNodes(deps)

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('retrieveNode', nodes.retrieveNode)
    .addNode('diagnoseNode', nodes.diagnoseNode)
    .addNode('planNode', nodes.planNode)
    .addNode('patchNode', nodes.patchNode)
    .addNode('sandboxNode', nodes.sandboxNode)
    .addNode('openPrNode', nodes.openPrNode)
    .addNode('mergePrNode', nodes.mergePrNode)

    .addEdge(START, 'retrieveNode')
    .addEdge('retrieveNode', 'diagnoseNode')
    .addEdge('diagnoseNode', 'planNode')
    .addEdge('planNode', 'patchNode')
    .addEdge('patchNode', 'sandboxNode')
    .addConditionalEdges('sandboxNode', (state: AgentState) => {
      const verdict = state.sandboxResult?.verdict
      if (verdict === 'pass') {
        return 'openPrNode'
      }
      if (state.attemptNumber < state.maxAttempts) {
        return 'diagnoseNode'
      }
      return END
    })
    .addEdge('openPrNode', 'mergePrNode')
    .addEdge('mergePrNode', END)

  return graph.compile()
}
