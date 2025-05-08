import { copycat } from '@snaplet/copycat'
import { DatabaseClient, SubsetConfig } from '@snaplet/sdk/cli'

import { Table } from './types.js'

export type ConfigToSQL = {
  where?: string
  tableSubset?: string
  limit?: string
  orderBy?: string
}
const BELFRY_TEST_FIRM_ID = '01411827-bfe8-4c41-ab44-ec594c4670a8'


async function getPreciseCount(
  client: DatabaseClient,
  table: { schema: string; name: string, columns: {name: string}[] }
) {
  let query = `SELECT COUNT(*) as count FROM ${client.escapeIdentifier(
      table.schema
    )}.${client.escapeIdentifier(table.name)}`

  if (table.name === 'firm') {
    query += ` WHERE id='${BELFRY_TEST_FIRM_ID}'::uuid`
  } else if (table.columns.some(({name}) => name === 'firm_id')) {
    query += ` WHERE firm_id='${BELFRY_TEST_FIRM_ID}'::uuid`
  }
  const {
    rows: [{ count }],
  } = await client.query<{ count: number }>(query)

  return count
}

export async function configToSQL(
  client: DatabaseClient,
  configTarget: SubsetConfig['targets'][number],
  target: Pick<Table, 'id' | 'schema' | 'name' | 'columns'>
) {
  const sql: ConfigToSQL = {}
  let subsetRowCount: number | undefined
  if (configTarget.percent) {
    const count = await getPreciseCount(client, target)
    subsetRowCount = Math.round((count * configTarget.percent) / 100)
    // TODO: figure out why it's needed, I can of understand that sometimes the percentage can be less than what we expect
    // for example we have 100 rows and TABLESAMPLE BERNOULLI (10) will return 9 rows so we increase the percentage and use LIMIT to get the exact count
    const percentage = calculateSubsetSize(subsetRowCount, count)
    // A good read on table subsetting: https://www.2ndquadrant.com/en/blog/tablesubset-in-postgresql-9-5-2/
    sql.tableSubset = `TABLESAMPLE BERNOULLI (${
      // configTarget.percent
      percentage
    }) REPEATABLE(${copycat.int(target.id)})`
  } else if (configTarget.rowLimit) {
    const count = await getPreciseCount(client, target)
    subsetRowCount = Math.min(count, configTarget.rowLimit)
  }
  if (subsetRowCount) {
    sql.limit = `LIMIT ${subsetRowCount}`
  }

  if (configTarget.where) {
    sql.where = `WHERE ${configTarget.where}`
  }

  if (configTarget.orderBy) {
    sql.orderBy = `ORDER BY ${configTarget.orderBy}`
  }

  return sql
}

function calculateSubsetSize(
  subsetRowCount: number,
  totalRowCount: number
): number {
  // Protect against divide 0 NaN result on empty table
  if (totalRowCount > 0) {
    // Subset from table double the size of the subset
    const percentageDoubled =
      Math.ceil(subsetRowCount / totalRowCount) * 100 * 2

    if (percentageDoubled > 100) {
      return 100
    } else {
      return percentageDoubled
    }
  } else {
    return 0
  }
}
