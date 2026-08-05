/**
 * The table designer's entry point: one import for the UI, whichever server the
 * connection is talking to.
 */

import type { DbEngine, DesignerState } from '@shared/types'
import { buildMysqlDesignerSql } from './designerSql'
import { buildPostgresDesignerSql } from './designerSqlPg'

export {
  designerFromDefinition,
  emptyDesigner,
  newDesignerColumn
} from './designerShared'

export function buildDesignerSql(engine: DbEngine, state: DesignerState): string {
  return engine === 'postgres' ? buildPostgresDesignerSql(state) : buildMysqlDesignerSql(state)
}
