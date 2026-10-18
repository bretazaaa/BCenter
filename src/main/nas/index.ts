import type { NasDriverFactory } from './driver'
import { OmvDriver } from './omv'
import { PbsDriver } from './pbs'
import { QnapDriver } from './qnap'
import { SynologyDriver } from './synology'
import { TrueNasDriver } from './truenas'
import { UnraidDriver } from './unraid'

export const createNasDriver: NasDriverFactory = (nas, secrets) => {
  switch (nas.kind) {
    case 'truenas': return new TrueNasDriver(nas, secrets)
    case 'synology': return new SynologyDriver(nas, secrets)
    case 'unraid': return new UnraidDriver(nas, secrets)
    case 'omv': return new OmvDriver(nas, secrets)
    case 'qnap': return new QnapDriver(nas, secrets)
    case 'pbs': return new PbsDriver(nas, secrets)
  }
}
