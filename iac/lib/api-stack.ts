import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";
import { AgoraDataStack } from "./data-stack";

export interface AgoraApiStackProps extends AgoraStackProps {
  data: AgoraDataStack;
}

export class AgoraApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgoraApiStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, "StackIdMarker", {
      value: this.stackName,
      description: "Agora stack marker",
    });
  }
}
