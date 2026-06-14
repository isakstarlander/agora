import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface NodeLambdaProps
  extends Omit<lambdaNodejs.NodejsFunctionProps, "runtime" | "architecture"> {
  functionName: string;
  memorySize?: number;
}

export class NodeLambda extends Construct {
  public readonly fn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: NodeLambdaProps) {
    super(scope, id);

    const { functionName, memorySize = 512, ...rest } = props;

    this.fn = new lambdaNodejs.NodejsFunction(this, "Fn", {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
      },
      tracing: lambda.Tracing.DISABLED,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        POWERTOOLS_SERVICE_NAME: functionName,
        LOG_LEVEL: "INFO",
        ...rest.environment,
      },
      ...rest,
    });
  }
}
