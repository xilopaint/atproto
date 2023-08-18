import { IdResolver } from '@atproto/identity'
import { PrimaryDatabase } from '../db'
import { Labeler } from '../labeler'
import { BackgroundQueue } from '../background'
import { IndexingService } from '../services/indexing'
import { LabelService } from '../services/label'

export function createServices(resources: {
  idResolver: IdResolver
  labeler: Labeler
  backgroundQueue: BackgroundQueue
}): Services {
  const { idResolver, labeler, backgroundQueue } = resources
  return {
    indexing: IndexingService.creator(idResolver, labeler, backgroundQueue),
    label: LabelService.creator(null),
  }
}

export type Services = {
  indexing: FromDbPrimary<IndexingService>
  label: FromDbPrimary<LabelService>
}

type FromDbPrimary<T> = (db: PrimaryDatabase) => T
