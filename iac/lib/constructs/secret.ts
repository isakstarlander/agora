import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface EmptySecretProps {
  secretName: string;
  description?: string;
}

/**
 * Creates a Secrets Manager secret with an empty JSON value `{}`.
 * The actual secret value must be populated manually post-deploy.
 */
export class EmptySecret extends Construct {
  public readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: EmptySecretProps) {
    super(scope, id);

    this.secret = new secretsmanager.Secret(this, "Secret", {
      secretName: props.secretName,
      description: props.description,
      generateSecretString: undefined,
      secretObjectValue: {},
    });
  }
}
