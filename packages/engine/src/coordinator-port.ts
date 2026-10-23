import type {
  HolderRequest,
  HolderResult,
  MessagingEventBody,
  OpenQuestion,
} from "./messaging/messaging";

/**
 * Answers for a run's outside participants, as a holder does with `awf reply` and `awf send`. Its
 * message numbers are the attempt's; `awf inbox` names them `{attempt}.{n}`.
 */
export type CoordinatorHolder = {
  reply(request: HolderRequest): Promise<HolderResult>;
  send(request: HolderRequest): Promise<HolderResult>;
  /** Questions open to outside participants now, oldest first. */
  open(): OpenQuestion[];
};

/**
 * What answers for a run's outside participants plugs in here: `awf run`'s prompt, the socket, or a
 * test's scripts. Told each messaging event once the run's log has it, and handed the holder before
 * the workflow runs. Reachable through `RunWorkflowOptions`, as `awaitReply` is, but not a
 * published surface: holders use `awf inbox`, `awf reply` and `awf send`.
 * @internal
 */
export type CoordinatorPort = {
  attach(holder: CoordinatorHolder): void;
  recorded(event: MessagingEventBody): void;
};
