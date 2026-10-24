import {
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  ModifySubnetAttributeCommand,
  type Filter,
  type ResourceType,
  type Tag,
} from '@aws-sdk/client-ec2';

// The EC2 boundary (Story MOTIR-9270 · MOTIR-9273) — the one module that speaks
// the AWS SDK for EC2, the AWS twin of `../fly/flyMachines.ts`.
//
// `Ec2Api` is the adapter-level surface: plain shapes, no SDK type crosses it, so
// the network function, the orchestrator adapter (MOTIR-9276) and their in-memory
// fake (`test/contract/awsEc2Fake.ts`) all code against one interface. The SDK is
// imported here and nowhere outside `adapters/aws/` — the story's architecture
// guard (MOTIR-9280) holds that line.
//
// ⚠️ NO ENVIRONMENT READ. Credentials arrive as an argument, so add-shard can pass
// the short-lived credentials of a role it assumed in a new Organizations member
// account (`sessionToken`), and the composition root can pass a shard's own key.

/** Where an EC2 call goes and who it is made as. */
export interface AwsCredentialsConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for credentials from an assumed role (STS `AssumeRole`). */
  readonly sessionToken?: string;
  readonly region: string;
}

/** One resource tag, as every create writes it and every describe returns it. */
export interface Ec2Tag {
  readonly key: string;
  readonly value: string;
}

/** One describe filter — `tag:<key>`, `vpc-id`, `state`, … as EC2 names them. */
export interface Ec2Filter {
  readonly name: string;
  readonly values: readonly string[];
}

/**
 * Any EC2 refusal or transport failure. `code` is AWS's error code
 * (`InvalidVpcID.NotFound`, `RequestLimitExceeded`) and NEVER the message: an
 * EC2 message about user-data can echo the value, and a code is what a caller
 * branches on.
 */
export class Ec2ApiError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number | null,
    readonly retryable: boolean,
  ) {
    super(`EC2 refused a call (${code}${httpStatus === null ? '' : `, HTTP ${httpStatus}`}).`);
    this.name = 'Ec2ApiError';
  }
}

export interface Ec2AvailabilityZone {
  readonly zoneName: string;
  readonly state: string;
}

export interface Ec2Vpc {
  readonly vpcId: string;
  readonly cidrBlock: string;
  readonly tags: readonly Ec2Tag[];
}

export interface Ec2InternetGateway {
  readonly internetGatewayId: string;
  readonly attachedVpcIds: readonly string[];
  readonly tags: readonly Ec2Tag[];
}

export interface Ec2Route {
  readonly destinationCidrBlock: string | null;
  readonly gatewayId: string | null;
}

export interface Ec2RouteTable {
  readonly routeTableId: string;
  readonly vpcId: string;
  readonly routes: readonly Ec2Route[];
  readonly associatedSubnetIds: readonly string[];
  readonly tags: readonly Ec2Tag[];
}

export interface Ec2Subnet {
  readonly subnetId: string;
  readonly vpcId: string;
  readonly availabilityZone: string;
  readonly cidrBlock: string;
  readonly mapPublicIpOnLaunch: boolean;
  readonly tags: readonly Ec2Tag[];
}

export interface Ec2SecurityGroup {
  readonly groupId: string;
  readonly groupName: string;
  readonly vpcId: string;
  /** How many inbound rules the group holds — the shard's group holds none. */
  readonly ingressRuleCount: number;
  readonly tags: readonly Ec2Tag[];
}

/**
 * The EC2 calls the AWS fleet makes, in adapter-level shapes. Every method throws
 * {@link Ec2ApiError} on a refusal. Grown per card: the network calls here, the
 * instance calls with the adapter.
 */
export interface Ec2Api {
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeAvailabilityZones.html */
  describeAvailabilityZones(filters: readonly Ec2Filter[]): Promise<Ec2AvailabilityZone[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeVpcs.html */
  describeVpcs(filters: readonly Ec2Filter[]): Promise<Ec2Vpc[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateVpc.html */
  createVpc(input: { cidrBlock: string; tags: readonly Ec2Tag[] }): Promise<{ vpcId: string }>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInternetGateways.html */
  describeInternetGateways(filters: readonly Ec2Filter[]): Promise<Ec2InternetGateway[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateInternetGateway.html */
  createInternetGateway(input: { tags: readonly Ec2Tag[] }): Promise<{ internetGatewayId: string }>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AttachInternetGateway.html */
  attachInternetGateway(input: { internetGatewayId: string; vpcId: string }): Promise<void>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRouteTables.html */
  describeRouteTables(filters: readonly Ec2Filter[]): Promise<Ec2RouteTable[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateRouteTable.html */
  createRouteTable(input: {
    vpcId: string;
    tags: readonly Ec2Tag[];
  }): Promise<{ routeTableId: string }>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateRoute.html */
  createRoute(input: {
    routeTableId: string;
    destinationCidrBlock: string;
    gatewayId: string;
  }): Promise<void>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AssociateRouteTable.html */
  associateRouteTable(input: { routeTableId: string; subnetId: string }): Promise<void>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeSubnets.html */
  describeSubnets(filters: readonly Ec2Filter[]): Promise<Ec2Subnet[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateSubnet.html */
  createSubnet(input: {
    vpcId: string;
    cidrBlock: string;
    availabilityZone: string;
    tags: readonly Ec2Tag[];
  }): Promise<{ subnetId: string }>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ModifySubnetAttribute.html */
  modifySubnetAttribute(input: { subnetId: string; mapPublicIpOnLaunch: boolean }): Promise<void>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeSecurityGroups.html */
  describeSecurityGroups(filters: readonly Ec2Filter[]): Promise<Ec2SecurityGroup[]>;
  /** https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateSecurityGroup.html */
  createSecurityGroup(input: {
    groupName: string;
    description: string;
    vpcId: string;
    tags: readonly Ec2Tag[];
  }): Promise<{ groupId: string }>;
}

/** The slice of `EC2Client` the factory uses — what a test stubs. */
export interface Ec2SdkClient {
  send(command: unknown): Promise<unknown>;
}

/** How the factory builds its SDK client — the default is `new EC2Client(config)`. */
export type Ec2SdkClientFactory = (config: {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}) => Ec2SdkClient;

const defaultClientFactory: Ec2SdkClientFactory = (config) => new EC2Client(config);

function sdkFilters(filters: readonly Ec2Filter[]): Filter[] | undefined {
  return filters.length > 0
    ? filters.map((f) => ({ Name: f.name, Values: [...f.values] }))
    : undefined;
}

function sdkTagSpecs(resourceType: ResourceType, tags: readonly Ec2Tag[]) {
  return [{ ResourceType: resourceType, Tags: tags.map((t) => ({ Key: t.key, Value: t.value })) }];
}

function tagsOf(tags: readonly Tag[] | undefined): Ec2Tag[] {
  return (tags ?? []).map((t) => ({ key: t.Key ?? '', value: t.Value ?? '' }));
}

/** Required string from an SDK answer; a missing id is a malformed answer. */
function required(value: string | undefined, what: string): string {
  if (!value) throw new Ec2ApiError(`MissingField.${what}`, null, false);
  return value;
}

interface SdkErrorShape {
  readonly name?: unknown;
  readonly Code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
  readonly $retryable?: unknown;
}

/** Turn whatever the SDK threw into an {@link Ec2ApiError} carrying the code only. */
export function toEc2ApiError(err: unknown): Ec2ApiError {
  if (err instanceof Ec2ApiError) return err;
  const shape = (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
  const code =
    typeof shape.Code === 'string' && shape.Code
      ? shape.Code
      : typeof shape.name === 'string' && shape.name
        ? shape.name
        : 'UnknownError';
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number' ? shape.$metadata.httpStatusCode : null;
  const retryable = Boolean(shape.$retryable) || status === null || status >= 500;
  return new Ec2ApiError(code, status, retryable);
}

/** An {@link Ec2Api} over `@aws-sdk/client-ec2`. `clientFactory` is the test seam. */
export function createEc2Api(
  config: AwsCredentialsConfig,
  clientFactory: Ec2SdkClientFactory = defaultClientFactory,
): Ec2Api {
  const client = clientFactory({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
  async function send<T>(command: unknown): Promise<T> {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw toEc2ApiError(err);
    }
  }
  return networkCalls(send);
}

type Send = <T>(command: unknown) => Promise<T>;

function networkCalls(send: Send): Ec2Api {
  return {
    async describeAvailabilityZones(filters) {
      const out = await send<{ AvailabilityZones?: { ZoneName?: string; State?: string }[] }>(
        new DescribeAvailabilityZonesCommand({ Filters: sdkFilters(filters) }),
      );
      return (out.AvailabilityZones ?? []).map((z) => ({
        zoneName: required(z.ZoneName, 'ZoneName'),
        state: z.State ?? '',
      }));
    },
    async describeVpcs(filters) {
      const out = await send<{ Vpcs?: { VpcId?: string; CidrBlock?: string; Tags?: Tag[] }[] }>(
        new DescribeVpcsCommand({ Filters: sdkFilters(filters) }),
      );
      return (out.Vpcs ?? []).map((v) => ({
        vpcId: required(v.VpcId, 'VpcId'),
        cidrBlock: v.CidrBlock ?? '',
        tags: tagsOf(v.Tags),
      }));
    },
    async createVpc({ cidrBlock, tags }) {
      const out = await send<{ Vpc?: { VpcId?: string } }>(
        new CreateVpcCommand({ CidrBlock: cidrBlock, TagSpecifications: sdkTagSpecs('vpc', tags) }),
      );
      return { vpcId: required(out.Vpc?.VpcId, 'VpcId') };
    },
    async describeInternetGateways(filters) {
      const out = await send<{
        InternetGateways?: {
          InternetGatewayId?: string;
          Attachments?: { VpcId?: string }[];
          Tags?: Tag[];
        }[];
      }>(new DescribeInternetGatewaysCommand({ Filters: sdkFilters(filters) }));
      return (out.InternetGateways ?? []).map((g) => ({
        internetGatewayId: required(g.InternetGatewayId, 'InternetGatewayId'),
        attachedVpcIds: (g.Attachments ?? []).flatMap((a) => (a.VpcId ? [a.VpcId] : [])),
        tags: tagsOf(g.Tags),
      }));
    },
    async createInternetGateway({ tags }) {
      const out = await send<{ InternetGateway?: { InternetGatewayId?: string } }>(
        new CreateInternetGatewayCommand({
          TagSpecifications: sdkTagSpecs('internet-gateway', tags),
        }),
      );
      return {
        internetGatewayId: required(out.InternetGateway?.InternetGatewayId, 'InternetGatewayId'),
      };
    },
    async attachInternetGateway({ internetGatewayId, vpcId }) {
      await send(
        new AttachInternetGatewayCommand({ InternetGatewayId: internetGatewayId, VpcId: vpcId }),
      );
    },
    async describeRouteTables(filters) {
      const out = await send<{
        RouteTables?: {
          RouteTableId?: string;
          VpcId?: string;
          Routes?: { DestinationCidrBlock?: string; GatewayId?: string }[];
          Associations?: { SubnetId?: string }[];
          Tags?: Tag[];
        }[];
      }>(new DescribeRouteTablesCommand({ Filters: sdkFilters(filters) }));
      return (out.RouteTables ?? []).map((t) => ({
        routeTableId: required(t.RouteTableId, 'RouteTableId'),
        vpcId: t.VpcId ?? '',
        routes: (t.Routes ?? []).map((r) => ({
          destinationCidrBlock: r.DestinationCidrBlock ?? null,
          gatewayId: r.GatewayId ?? null,
        })),
        associatedSubnetIds: (t.Associations ?? []).flatMap((a) =>
          a.SubnetId ? [a.SubnetId] : [],
        ),
        tags: tagsOf(t.Tags),
      }));
    },
    async createRouteTable({ vpcId, tags }) {
      const out = await send<{ RouteTable?: { RouteTableId?: string } }>(
        new CreateRouteTableCommand({
          VpcId: vpcId,
          TagSpecifications: sdkTagSpecs('route-table', tags),
        }),
      );
      return { routeTableId: required(out.RouteTable?.RouteTableId, 'RouteTableId') };
    },
    async createRoute({ routeTableId, destinationCidrBlock, gatewayId }) {
      await send(
        new CreateRouteCommand({
          RouteTableId: routeTableId,
          DestinationCidrBlock: destinationCidrBlock,
          GatewayId: gatewayId,
        }),
      );
    },
    async associateRouteTable({ routeTableId, subnetId }) {
      await send(
        new AssociateRouteTableCommand({ RouteTableId: routeTableId, SubnetId: subnetId }),
      );
    },
    async describeSubnets(filters) {
      const out = await send<{
        Subnets?: {
          SubnetId?: string;
          VpcId?: string;
          AvailabilityZone?: string;
          CidrBlock?: string;
          MapPublicIpOnLaunch?: boolean;
          Tags?: Tag[];
        }[];
      }>(new DescribeSubnetsCommand({ Filters: sdkFilters(filters) }));
      return (out.Subnets ?? []).map((s) => ({
        subnetId: required(s.SubnetId, 'SubnetId'),
        vpcId: s.VpcId ?? '',
        availabilityZone: s.AvailabilityZone ?? '',
        cidrBlock: s.CidrBlock ?? '',
        mapPublicIpOnLaunch: s.MapPublicIpOnLaunch === true,
        tags: tagsOf(s.Tags),
      }));
    },
    async createSubnet({ vpcId, cidrBlock, availabilityZone, tags }) {
      const out = await send<{ Subnet?: { SubnetId?: string } }>(
        new CreateSubnetCommand({
          VpcId: vpcId,
          CidrBlock: cidrBlock,
          AvailabilityZone: availabilityZone,
          TagSpecifications: sdkTagSpecs('subnet', tags),
        }),
      );
      return { subnetId: required(out.Subnet?.SubnetId, 'SubnetId') };
    },
    async modifySubnetAttribute({ subnetId, mapPublicIpOnLaunch }) {
      await send(
        new ModifySubnetAttributeCommand({
          SubnetId: subnetId,
          MapPublicIpOnLaunch: { Value: mapPublicIpOnLaunch },
        }),
      );
    },
    async describeSecurityGroups(filters) {
      const out = await send<{
        SecurityGroups?: {
          GroupId?: string;
          GroupName?: string;
          VpcId?: string;
          IpPermissions?: unknown[];
          Tags?: Tag[];
        }[];
      }>(new DescribeSecurityGroupsCommand({ Filters: sdkFilters(filters) }));
      return (out.SecurityGroups ?? []).map((g) => ({
        groupId: required(g.GroupId, 'GroupId'),
        groupName: g.GroupName ?? '',
        vpcId: g.VpcId ?? '',
        ingressRuleCount: (g.IpPermissions ?? []).length,
        tags: tagsOf(g.Tags),
      }));
    },
    async createSecurityGroup({ groupName, description, vpcId, tags }) {
      // A new group carries AWS's default allow-all EGRESS rule and no ingress
      // rule; the shard's group keeps exactly that, so nothing is authorized or
      // revoked after the create.
      const out = await send<{ GroupId?: string }>(
        new CreateSecurityGroupCommand({
          GroupName: groupName,
          Description: description,
          VpcId: vpcId,
          TagSpecifications: sdkTagSpecs('security-group', tags),
        }),
      );
      return { groupId: required(out.GroupId, 'GroupId') };
    },
  };
}
