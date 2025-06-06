import {
  DataModel,
  DataModelObjectField,
  DataModelScalarField,
  groupFields,
} from '../dataModel/dataModel.js'
import { isOptionsField, type Fingerprint } from '../dataModel/fingerprint.js'
import { Store } from '../store.js'
import {
  ChildField,
  ChildModel,
  ClientState,
  ConnectCallback,
  ConnectInstruction,
  CountCallback,
  GenerateOptions,
  IPlan,
  ModelRecord,
  ParentField,
  PlanInputs,
  ScalarField,
  UserModels,
} from './types.js'
import { copycat } from '@snaplet/copycat'
import { mergeUserModels } from '../utils/mergeUserModels.js'
import { Json } from '~/types.js'
import { dedupePreferLast } from '../utils/dedupePreferLast.js'
import { serializeModelValues, serializeValue } from './serialize.js'
import { checkConstraints } from '../constraints.js'

export type PlanOptions = {
  connect?: true | Record<string, Array<any>>
  models?: UserModels
  seed?: string
}

export class Plan implements IPlan {
  private readonly ctx: ClientState
  private readonly dataModel: DataModel
  private readonly plan: PlanInputs
  private readonly userModels: UserModels
  private readonly fingerprint: Fingerprint
  private readonly connectStore?: Record<string, Array<any>>
  private readonly seed?: string
  private readonly runStatements?: (statements: string[]) => Promise<any>

  public store: Store
  public options?: PlanOptions

  constructor(props: {
    ctx: ClientState
    runStatements?: (statements: string[]) => Promise<void>
    dataModel: DataModel
    userModels: UserModels
    plan: PlanInputs
    fingerprint?: Fingerprint
    options?: PlanOptions
  }) {
    this.ctx = props.ctx
    this.runStatements = props.runStatements
    this.dataModel = props.dataModel
    this.fingerprint = props.fingerprint ?? {}
    this.plan = props.plan
    // plan's internal store
    this.store = new Store(props.dataModel)
    if (props.options?.connect) {
      if (props.options.connect === true) {
        this.connectStore = this.ctx.store._store
      } else {
        const partialStore = props.options.connect
        this.connectStore = Object.fromEntries(
          Object.keys(this.dataModel.models).map((modelName) => [
            modelName,
            partialStore[modelName] ?? [],
          ])
        )
      }
    }
    this.seed = props.options?.seed
    this.userModels = props.userModels
    this.options = props.options
  }

  async generate(options?: GenerateOptions) {
    const seed = this.seed ?? options?.seed
    // if generate receives options?.models it means it comes from a merge or pipe
    const userModels = mergeUserModels(
      mergeUserModels(this.userModels, options?.models ?? {}),
      this.options?.models ?? {}
    )

    if (this.connectStore) {
      for (const modelName of Object.keys(this.connectStore)) {
        if (this.connectStore[modelName].length > 0) {
          const connectFallback: ConnectCallback = (ctx) =>
            copycat.oneOf(ctx.seed, this.connectStore![modelName])
          // @ts-expect-error tagging the fallback function for retry purposes when checking constraints
          connectFallback['fallback'] = true
          userModels[modelName].connect =
            userModels[modelName].connect ?? connectFallback
        }
      }
    }

    if (this.ctx.seeds[this.plan.model] === undefined) {
      this.ctx.seeds[this.plan.model] = -1
    }
    this.ctx.seeds[this.plan.model] += 1

    await this.generateModel(
      { ...this.plan },
      {
        models: userModels,
        seed: seed ?? this.ctx.seeds[this.plan.model].toString(),
      }
    )

    return this.store
  }

  async run() {
    const store = await this.generate()
    await this.runStatements?.(store.toSQL())
    return store._store
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?:
      | ((value: any) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: any) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected)
  }

  private async generateModel(
    {
      ctx,
      model,
      inputs,
    }: PlanInputs & {
      ctx?: {
        index?: number
        path?: (string | number)[]
      }
    },
    options: Required<GenerateOptions>
  ) {
    const path = ctx?.path ?? [model]
    const userModels = options.models
    const modelStructure = this.dataModel.models[model]

    // this is the "x" function that we inject for child fields: (x) => x(10, (i) => ({ id: i }))
    const countCallback: CountCallback = (x, cb) => {
      const result: Array<ChildModel> = []

      const seed = `${options.seed}/${path.join('/')}`
      const n = typeof x === 'number' ? x : copycat.int(seed, x)

      for (const i of new Array(n).keys()) {
        if (cb === undefined) {
          result.push({})
        } else if (typeof cb === 'function') {
          result.push(
            cb({
              $store: this.ctx.store._store,
              data: {},
              store: this.store._store,
              index: i,
              seed: [seed, i].join('/'),
            })
          )
        } else {
          result.push(cb)
        }
      }

      return result
    }

    const modelsInputs =
      typeof inputs === 'function'
        ? inputs(countCallback)
        : Array.isArray(inputs)
          ? inputs
          : [inputs]

    const generatedModels: Record<string, any>[] = []

    // we partition the fields into 3 categories:
    // - scalar fields
    // - parent relation fields
    // - child relation fields
    const fields = groupFields(modelStructure.fields)

    for (let index = 0; index < modelsInputs.length; index++) {
      const modelData: Record<string, any> = {}
      const modelSeed = `${options.seed}/${[...path, index].join('/')}`

      const modelInputs = modelsInputs[index]

      const inputsData = (
        typeof modelInputs === 'function'
          ? modelInputs({
              $store: this.ctx.store._store,
              data: {},
              index,
              seed: modelSeed,
              store: this.store._store,
            })
          : modelsInputs[index]
      ) as ModelRecord

      for (const field of fields.parents) {
        // the parent ids were already provided (by the user or by children generation)
        const parentIdsProvided = field.relationFromFields.every(
          (f) => inputsData[f] !== undefined
        )
        if (parentIdsProvided) {
          for (const f of field.relationFromFields) {
            modelData[f] = inputsData[f]
          }
          continue
        }

        // right now let's not generate nullable parent relations if the user did not specify them or if there is no connect fallback
        if (
          !field.isRequired &&
          inputsData[field.name] === undefined &&
          !userModels[field.type].connect
        ) {
          for (const f of field.relationFromFields) {
            modelData[f] = null
          }
          continue
        }

        const getParent = async (parentField?: ParentField) => {
          const parentModelName = field.type

          if (parentField === undefined) {
            const connectFallback = userModels[parentModelName].connect
            if (connectFallback) {
              return connectFallback({
                $store: this.ctx.store._store,
                store: this.store._store,
                index,
                seed: `${modelSeed}/${field.name}`,
              })
            }
          }

          // if parentField is defined, it means the user wants to override the default behavior
          // is the parentField a modelCallback
          if (typeof parentField === 'function') {
            const modelCallbackResult = parentField({
              $store: this.ctx.store._store,
              connect: (cb) => new ConnectInstruction(cb),
              data: {},
              seed: [modelSeed, field.name, 0].join('/'),
              store: this.store._store,
            })

            if (modelCallbackResult instanceof ConnectInstruction) {
              return modelCallbackResult.callback({
                $store: this.ctx.store._store,
                store: this.store._store,
                index,
                seed: `${modelSeed}/${field.name}`,
              })
            }

            parentField = modelCallbackResult
          }

          const parent = (
            await this.generateModel(
              {
                ctx: {
                  index,
                  path: [...path, index, field.name],
                },
                model: parentModelName,
                // todo: support aliases or fetch relation names
                inputs: [parentField ?? {}] as ChildField,
              },
              options
            )
          )[0]

          return parent
        }

        const parent = serializeModelValues(
          await getParent(inputsData[field.name] as ParentField | undefined)
        )

        for (const [i] of field.relationFromFields.entries()) {
          modelData[field.relationFromFields[i]] =
            parent[field.relationToFields[i]]
        }
      }

      const handleScalarField = async (field: DataModelScalarField) => {
        const scalarField = inputsData[field.name] as ScalarField | undefined
        // the field is always generated by the database
        if (!field.isId && field.isGenerated) {
          return
        }
        // the field has a default value generated by the database
        // and is not a sequence that we gonna mock
        // we can skip it if the user didn't provide a value
        if (
          !field.isId &&
          field.hasDefaultValue &&
          field.sequence === false &&
          scalarField === undefined
        ) {
          return
        }
        // the field was already taken care of by a parent relation
        if (modelData[field.name] !== undefined) {
          return
        }

        const generateFn =
          scalarField === undefined
            ? userModels[model].data?.[field.name]
            : scalarField

        const value =
          typeof generateFn === 'function'
            ? await generateFn({
                index: ctx?.index ?? index,
                seed: `${modelSeed}/${field.name}`,
                data: modelData,
                $store: this.ctx.store._store,
                store: this.store._store,
                options: this.getGenerateOptions(model, field.name),
              })
            : generateFn

        modelData[field.name] = serializeValue(value)
      }

      // we prioritize ids so we can access them in the store as soon as possible
      for (const field of fields.scalars.filter((f) => f.isId)) {
        await handleScalarField(field)
      }

      // we persist the generated model as soon as we have the ids
      this.store.add(model, modelData)
      this.ctx.store.add(model, modelData)
      generatedModels.push(modelData)

      const scalarFields = this.sortScalars(
        model,
        fields.scalars,
        userModels,
        inputsData
      )

      // TODO: filter out the fields that are part of a parent relation
      for (const field of scalarFields.filter((f) => !f.isId)) {
        await handleScalarField(field)
      }

      await checkConstraints({
        connectStore: this.connectStore,
        constraintsStores: this.ctx.constraints,
        uniqueConstraints: modelStructure.uniqueConstraints,
        modelData,
        model,
        parentFields: fields.parents,
        inputsData,
        scalarFields,
        modelSeed,
        userModels,
        generateFnCtx: (fieldName: string, counter: number) => ({
          index: ctx?.index ?? index,
          seed: `${modelSeed}/${fieldName}/${counter}`,
          data: modelData,
          $store: this.ctx.store._store,
          store: this.store._store,
          options: this.getGenerateOptions(model, fieldName),
        }),
      })

      for (const field of fields.children) {
        const childModelName = field.type
        const childField = inputsData[field.name] as ChildField | undefined
        // skip cyclic relationships where the child is the same as the parent
        if (
          fields.parents.find(
            (p) => p.name === field.name && p.type === field.type
          )
        ) {
          continue
        }

        // for now if the child is not user defined, we don't generate it
        if (!childField) {
          continue
        }
        // we need to find the corresponding relationship in the child to get the impacted columns
        const childModel = this.dataModel.models[childModelName]
        const childRelation = childModel.fields.find(
          (f) => f.kind === 'object' && f.relationName === field.relationName
        )! as DataModelObjectField

        const childFields: Record<string, any> = {}
        for (const [i] of childRelation.relationFromFields.entries()) {
          childFields[childRelation.relationFromFields[i]] =
            modelData[childRelation.relationToFields[i]]
        }

        let childInputs: ChildField
        if (typeof childField === 'function') {
          childInputs = (cb: CountCallback) => {
            return childField(cb).map((childData, index) => {
              if (typeof childData === 'function') {
                childData = childData({
                  $store: this.ctx.store._store,
                  data: {},
                  index,
                  seed: [modelSeed, field.name, index].join('/'),
                  store: this.store._store,
                })
              }
              return {
                ...childData,
                ...childFields,
              }
            })
          }
        } else {
          childInputs = childField.map((childData, index) => {
            if (typeof childData === 'function') {
              childData = childData({
                $store: this.ctx.store._store,
                data: {},
                index,
                seed: [modelSeed, field.name, index].join('/'),
                store: this.store._store,
              })
            }
            return {
              ...childData,
              ...childFields,
            }
          })
        }

        await this.generateModel(
          {
            ctx: {
              path: [...path, index, field.name],
            },
            model: childModelName,
            inputs: childInputs,
          },
          options
        )
      }
    }

    return generatedModels
  }

  private getGenerateOptions(modelName: string, fieldName: string) {
    const fingerprintField = this.fingerprint[modelName]?.[fieldName] ?? {}

    if (isOptionsField(fingerprintField)) {
      return fingerprintField.options as Record<string, Json>
    } else {
      return {}
    }
  }

  private sortScalars(
    modelName: string,
    fields: DataModelScalarField[],
    userModels: UserModels,
    inputsData: ModelRecord | null | undefined
  ): DataModelScalarField[] {
    const fieldMap = new Map(fields.map((field) => [field.name, field]))

    const orderedFieldNames = dedupePreferLast([
      ...fieldMap.keys(),
      ...Object.keys(userModels[modelName]?.data ?? {}),
      ...Object.keys(inputsData ?? {}),
    ]).filter((fieldName) => fieldMap.has(fieldName))

    return orderedFieldNames.map((name) => fieldMap.get(name)!)
  }
}
