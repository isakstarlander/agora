import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Construct } from "constructs";
import * as path from "path";

export interface ParquetLambdaProps {
  functionName: string;
  assetPath: string;
  memorySize?: number;
  timeout?: cdk.Duration;
  environment?: Record<string, string>;
}

export class ParquetLambda extends Construct {
  public readonly fn: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ParquetLambdaProps) {
    super(scope, id);

    const {
      functionName,
      assetPath,
      memorySize = 1024,
      timeout = cdk.Duration.minutes(5),
      environment = {},
    } = props;

    this.fn = new lambda.DockerImageFunction(this, "Fn", {
      functionName,
      architecture: lambda.Architecture.ARM_64,
      memorySize,
      timeout,
      tracing: lambda.Tracing.DISABLED,
      logRetention: logs.RetentionDays.ONE_MONTH,
      code: lambda.DockerImageCode.fromImageAsset(
        path.resolve(assetPath),
        { platform: Platform.LINUX_ARM64 }
      ),
      environment,
    });
  }
}
