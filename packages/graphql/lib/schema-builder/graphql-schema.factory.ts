import { BuildSchemaOptions, ScalarsTypeMap } from '../interfaces';
import {
  GraphQLError,
  GraphQLSchema,
  getIntrospectionQuery,
  graphql,
  specifiedDirectives,
} from 'graphql';
import { Injectable, Logger, Type } from '@nestjs/common';
import {
  SCALAR_NAME_METADATA,
  SCALAR_TYPE_METADATA,
} from '../graphql.constants';
import { isEmpty, isFunction } from '@nestjs/common/utils/shared.utils';

import { LazyMetadataStorage } from './storages/lazy-metadata.storage';
import { MutationTypeFactory } from './factories/mutation-type.factory';
import { OrphanedTypesFactory } from './factories/orphaned-types.factory';
import { QueryTypeFactory } from './factories/query-type.factory';
import { SchemaGenerationError } from './errors/schema-generation.error';
import { SubscriptionTypeFactory } from './factories/subscription-type.factory';
import { TypeDefinitionsGenerator } from './type-definitions.generator';
import { TypeMetadataStorage } from './storages/type-metadata.storage';
import { createScalarType } from '../utils/scalar-types.utils';

@Injectable()
export class GraphQLSchemaFactory {
  private readonly logger = new Logger(GraphQLSchemaFactory.name);

  constructor(
    private readonly queryTypeFactory: QueryTypeFactory,
    private readonly mutationTypeFactory: MutationTypeFactory,
    private readonly subscriptionTypeFactory: SubscriptionTypeFactory,
    private readonly orphanedTypesFactory: OrphanedTypesFactory,
    private readonly typeDefinitionsGenerator: TypeDefinitionsGenerator,
  ) {}

  async create(resolvers: Function[]): Promise<GraphQLSchema>;
  async create(
    resolvers: Function[],
    scalarClasses: Function[],
  ): Promise<GraphQLSchema>;
  async create(
    resolvers: Function[],
    options: BuildSchemaOptions,
  ): Promise<GraphQLSchema>;
  async create(
    resolvers: Function[],
    scalarClasses: Function[],
    options: BuildSchemaOptions,
  ): Promise<GraphQLSchema>;
  async create(
    resolvers: Function[],
    scalarsOrOptions: Function[] | BuildSchemaOptions = [],
    options: BuildSchemaOptions = {},
  ): Promise<GraphQLSchema> {
    if (Array.isArray(scalarsOrOptions)) {
      this.assignScalarObjects(scalarsOrOptions, options);
    } else {
      options = scalarsOrOptions;
    }

    TypeMetadataStorage.clear();
    LazyMetadataStorage.load(resolvers);
    TypeMetadataStorage.compile(options.orphanedTypes);

    this.typeDefinitionsGenerator.generate(options);

    const schema = new GraphQLSchema({
      mutation: this.mutationTypeFactory.create(resolvers, options),
      query: this.queryTypeFactory.create(resolvers, options),
      subscription: this.subscriptionTypeFactory.create(resolvers, options),
      types: this.orphanedTypesFactory.create(options.orphanedTypes),
      directives: [...specifiedDirectives, ...(options.directives ?? [])],
    });

    if (!options.skipCheck) {
      const introspectionQuery = getIntrospectionQuery();

      //common constructor with graphql 15.8.X and 16.X
      const executionResult = await graphql({
        schema,
        source: introspectionQuery,
      });
      const errors = executionResult.errors;
      if (errors) {
        throw new SchemaGenerationError(errors);
      }
    }

    return schema;
  }

  private assignScalarObjects(
    scalars: Function[],
    options: BuildSchemaOptions,
  ) {
    if (isEmpty(scalars)) {
      return;
    }
    const scalarsMap = options.scalarsMap || [];
    scalars
      .filter((classRef) => classRef)
      .forEach((classRef) =>
        this.addScalarTypeByClassRef(classRef as Type<unknown>, scalarsMap),
      );

    options.scalarsMap = scalarsMap;
  }

  private addScalarTypeByClassRef(
    classRef: Type<unknown>,
    scalarsMap: ScalarsTypeMap[],
  ) {
    try {
      const scalarNameMetadata = Reflect.getMetadata(
        SCALAR_NAME_METADATA,
        classRef,
      );
      const scalarTypeMetadata = Reflect.getMetadata(
        SCALAR_TYPE_METADATA,
        classRef,
      );
      if (!scalarNameMetadata) {
        return;
      }
      const instance = new (classRef as Type<unknown>)();
      const type =
        (isFunction(scalarTypeMetadata) && scalarTypeMetadata()) || classRef;

      scalarsMap.push({
        type,
        scalar: createScalarType(scalarNameMetadata, instance),
      });
    } catch {
      this.logger.error(
        `Cannot generate a GraphQLScalarType for "${classRef.name}" scalar. Make sure to put any initialization logic in the lifecycle hooks instead of a constructor.`,
      );
    }
  }
}
