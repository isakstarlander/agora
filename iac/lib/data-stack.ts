import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as glue from "aws-cdk-lib/aws-glue";
import * as sns from "aws-cdk-lib/aws-sns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";
import { EmptySecret } from "./constructs/secret";
import { NodeLambda } from "./constructs/node-lambda";
import { LambdaSchedule } from "./constructs/schedule";
import { currentRm } from "./constructs/env";

export class AgoraDataStack extends cdk.Stack {
  public readonly rawBucket: s3.Bucket;
  public readonly parquetBucket: s3.Bucket;
  public readonly logsBucket: s3.Bucket;
  public readonly rawManifestTopic: sns.Topic;
  public readonly ingestCursorsTable: dynamodb.Table;
  public readonly ingestionRunsTable: dynamodb.Table;
  public readonly summaryCacheTable: dynamodb.Table;
  public readonly accountabilityCacheTable: dynamodb.Table;
  public readonly accountabilityJobsTable: dynamodb.Table;
  public readonly ratelimitCounterTable: dynamodb.Table;
  public readonly manifestoKey: EmptySecret;
  public readonly baseLambdaPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: AgoraStackProps) {
    super(scope, id, props);

    // --- S3 Buckets ---

    this.rawBucket = new s3.Bucket(this, "RawBucket", {
      bucketName: `agora-raw-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
          expiration: cdk.Duration.days(1095),
        },
      ],
    });

    this.parquetBucket = new s3.Bucket(this, "ParquetBucket", {
      bucketName: `agora-parquet-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(180),
            },
          ],
        },
      ],
    });

    this.logsBucket = new s3.Bucket(this, "LogsBucket", {
      bucketName: `agora-logs-${this.account}`,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // --- SNS Topic for raw manifest notifications ---

    this.rawManifestTopic = new sns.Topic(this, "RawManifestTopic", {
      topicName: "agora-raw-manifests",
    });

    this.rawBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SnsDestination(this.rawManifestTopic),
      { suffix: "manifest.json" }
    );

    // --- DynamoDB Tables ---

    const tableDefaults = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    };

    this.ingestCursorsTable = new dynamodb.Table(this, "IngestCursorsTable", {
      ...tableDefaults,
      tableName: "agora_ingest_cursors",
      partitionKey: { name: "source_stream", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.ingestionRunsTable = new dynamodb.Table(this, "IngestionRunsTable", {
      ...tableDefaults,
      tableName: "agora_ingestion_runs",
      partitionKey: { name: "source", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "run_id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.summaryCacheTable = new dynamodb.Table(this, "SummaryCacheTable", {
      ...tableDefaults,
      tableName: "agora_summary_cache",
      partitionKey: { name: "dok_id_model", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.accountabilityCacheTable = new dynamodb.Table(this, "AccountabilityCacheTable", {
      ...tableDefaults,
      tableName: "agora_accountability_cache",
      partitionKey: { name: "party_topic_period", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.accountabilityJobsTable = new dynamodb.Table(this, "AccountabilityJobsTable", {
      ...tableDefaults,
      tableName: "agora_accountability_jobs",
      partitionKey: { name: "job_id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.ratelimitCounterTable = new dynamodb.Table(this, "RatelimitCounterTable", {
      ...tableDefaults,
      tableName: "agora_ratelimit_counter",
      partitionKey: { name: "principal", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "window_start", type: dynamodb.AttributeType.NUMBER },
      timeToLiveAttribute: "expires_at",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Glue Data Catalog database ---

    new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: { name: "agora_parquet" },
    });

    // --- Secrets Manager (empty, populated manually post-deploy) ---

    this.manifestoKey = new EmptySecret(this, "ManifestoApiKey", {
      secretName: "/agora/manifesto/api_key",
      description: "Manifesto Project WZB API key. Populated manually post-deploy.",
    });

    // --- EventBridge Scheduler group ---

    new scheduler.CfnScheduleGroup(this, "ScheduleGroup", {
      name: "agora-schedules",
    });

    // --- IAM managed policy shared by all Agora Lambdas ---

    this.baseLambdaPolicy = new iam.ManagedPolicy(this, "BaseLambdaPolicy", {
      managedPolicyName: "AgoraBaseLambdaPolicy",
      statements: [
        new iam.PolicyStatement({
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            StringEquals: { "cloudwatch:namespace": "Agora" },
          },
        }),
      ],
    });

    // --- Riksdagen ingestion Lambdas (PR-03) ---

    const ingestRole = new iam.Role(this, "IngestRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
        this.baseLambdaPolicy,
      ],
    });
    this.rawBucket.grantWrite(ingestRole);
    this.ingestCursorsTable.grantReadWriteData(ingestRole);
    this.ingestionRunsTable.grantWriteData(ingestRole);

    const handlerEntry = (name: string) =>
      path.join(
        __dirname,
        `../lambda/fetch-riks/src/handlers/${name}.ts`
      );

    const ingestEnv = {
      RAW_BUCKET: this.rawBucket.bucketName,
      CURSOR_TABLE: this.ingestCursorsTable.tableName,
      RUNS_TABLE: this.ingestionRunsTable.tableName,
    };

    const ingestFn = (id: string, entry: string): lambda.IFunction =>
      new NodeLambda(this, id, {
        functionName: `agora-${id
          .replace(/([A-Z])/g, "-$1")
          .toLowerCase()
          .replace(/^-/, "")}`,
        entry: handlerEntry(entry),
        role: ingestRole,
        timeout: cdk.Duration.minutes(5),
        environment: ingestEnv,
      }).fn;

    const fnDocs = ingestFn("FetchRiksDocuments", "documents");
    const fnVotes = ingestFn("FetchRiksVotes", "votes");
    const fnSpeeches = ingestFn("FetchRiksSpeeches", "speeches");
    const fnMembers = ingestFn("FetchRiksMembers", "members");

    const sched = (
      id: string,
      cron: string,
      target: lambda.IFunction,
      input: object
    ) =>
      new LambdaSchedule(this, id, {
        scheduleName: `agora-ingest-${id
          .replace(/([A-Z])/g, "-$1")
          .toLowerCase()
          .replace(/^-/, "")}`,
        cronExpression: cron,
        target,
        input: JSON.stringify(input),
        groupName: "agora-schedules",
      });

    const rm = currentRm();
    sched("RiksDocumentsMot", "cron(15 6 * * ? *)", fnDocs, { doktyp: "mot" });
    sched("RiksDocumentsProp", "cron(20 6 * * ? *)", fnDocs, { doktyp: "prop" });
    sched("RiksDocumentsBet", "cron(25 6 * * ? *)", fnDocs, { doktyp: "bet" });
    sched("RiksDocumentsSkr", "cron(27 6 * * ? *)", fnDocs, { doktyp: "skr" });
    sched("RiksDocumentsIp", "cron(29 6 * * ? *)", fnDocs, { doktyp: "ip" });
    sched("RiksDocumentsFr", "cron(31 6 * * ? *)", fnDocs, { doktyp: "fr" });
    sched("RiksVotes", "cron(40 6 * * ? *)", fnVotes, { rm });
    sched("RiksSpeechees", "cron(45 6 * * ? *)", fnSpeeches, { rm });
    sched("RiksMembers", "cron(0 3 * * ? *)", fnMembers, {});

    // --- CloudFormation Outputs ---

    new cdk.CfnOutput(this, "RawBucketName", { value: this.rawBucket.bucketName });
    new cdk.CfnOutput(this, "ParquetBucketName", { value: this.parquetBucket.bucketName });
    new cdk.CfnOutput(this, "LogsBucketName", { value: this.logsBucket.bucketName });
    new cdk.CfnOutput(this, "RawManifestTopicArn", { value: this.rawManifestTopic.topicArn });
    new cdk.CfnOutput(this, "IngestCursorsTableName", { value: this.ingestCursorsTable.tableName });
    new cdk.CfnOutput(this, "IngestionRunsTableName", { value: this.ingestionRunsTable.tableName });
    new cdk.CfnOutput(this, "SummaryCacheTableName", { value: this.summaryCacheTable.tableName });
    new cdk.CfnOutput(this, "AccountabilityCacheTableName", { value: this.accountabilityCacheTable.tableName });
    new cdk.CfnOutput(this, "AccountabilityJobsTableName", { value: this.accountabilityJobsTable.tableName });
    new cdk.CfnOutput(this, "RatelimitCounterTableName", { value: this.ratelimitCounterTable.tableName });
    new cdk.CfnOutput(this, "GlueDatabaseName", { value: "agora_parquet" });
    new cdk.CfnOutput(this, "ManifestoSecretArn", { value: this.manifestoKey.secret.secretArn });
    new cdk.CfnOutput(this, "ScheduleGroupName", { value: "agora-schedules" });
  }
}
