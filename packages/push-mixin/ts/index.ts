import { Type, Mode, Constructor, IRawRepo, Hash, isFile } from '@es-git/core';
import { IObjectRepo, GitObject, CommitObject, TreeObject } from '@es-git/object-mixin';
import { IWalkersRepo, HashAndCommitObject, withFeedback } from '@es-git/walkers-mixin';
import { lsRemote, push, Fetch, Command, Auth, Progress } from '@es-git/http-transport';
import getCommitsToPush from './getCommitsToPush';

export { Fetch, Auth };

export interface RefHash {
  readonly ref : string
  readonly hash : Hash
}

export interface PushOptions {
  readonly progress? : Progress
}

export interface RemoteUrl {
  readonly remote : string
  readonly url : string
}

export interface IPushRepo {
  push(remote : string | RemoteUrl, ref : string | string[], auth? : Auth, options? : PushOptions) : Promise<RefHash[]>
}

export default function pushMixin<T extends Constructor<IObjectRepo & IWalkersRepo & IRawRepo>>(repo : T, fetch : Fetch) : Constructor<IPushRepo> & T {
  return class PushRepo extends repo implements IPushRepo {
    async push(remote : string | RemoteUrl, ref : string | string[], auth? : Auth, options : PushOptions = {}) : Promise<RefHash[]> {
      const pairs = await this.getRefs(ref);

      const url = typeof remote === 'string' ? remote : remote.url;

      const {remoteRefs, capabilities} = await lsRemote(url, fetch);
      const pairsToUpdate = pairs.map(({ref, hash}) => ({
        ref,
        hash,
        remoteHash: (remoteRefs.filter(r => r.name === ref)[0] || {hash:'00'}).hash
      })).filter(p => p.hash !== p.remoteHash);
      if(pairsToUpdate.length === 0) return [];

      const remoteHashes = await Promise.all(remoteRefs.map(async ({hash}) => ({hash, known: await super.hasObject(hash)})))
        .then(a => a.filter(x => x.known).map(x => x.hash));
      const localWalk = super.walkCommits(...pairsToUpdate.map(p => p.hash));
      const {localCommits, commonCommits} = await getCommitsToPush(localWalk, ...remoteHashes.map(hash => super.walkCommits(hash)));
      const remoteObjects = new Set<Hash>();
      if(localCommits.length > 0){
        for(const {hash, commit} of commonCommits){
          await this.addToSet(hash, remoteObjects);
          if(await this.addToSet(commit.body.tree, remoteObjects)) continue;
          const walkTree = withFeedback(super.walkTree(commit.body.tree), true);
          for await(const {hash} of walkTree){
            walkTree.continue = await this.addToSet(hash, remoteObjects);
          }
        }
      }

      const localObjects = new Map<Hash, Uint8Array>();
      for(const {hash, commit} of localCommits){
        await this.addToMap(hash, localObjects, remoteObjects, options.progress);
        if(await this.addToMap(commit.body.tree, localObjects, remoteObjects, options.progress)) continue;
        const walkTree = withFeedback(super.walkTree(commit.body.tree), true);
        for await(const {hash} of walkTree){
          walkTree.continue = await this.addToMap(hash, localObjects, remoteObjects, options.progress);
        }
      }

      if(options.progress) options.progress(`Counting objects: ${localObjects.size}, done.\n`);

      await push(url, fetch, pairsToUpdate.map(makeCommand), localObjects, auth, options.progress);

      if(typeof remote !== 'string'){
        const remotePrefix = `refs/remotes/${remote.remote}/`;
        await Promise.all(pairsToUpdate.map(({ref, hash}) => super.setRef(ref.replace('refs/heads/', remotePrefix), hash)));
      }

      return pairsToUpdate;
    }

    private async addToSet(hash : string, set : Set<Hash>) {
      if(set.has(hash)) return true;
      set.add(hash);
      return false;
    }

    private async addToMap(hash : string, map : Map<Hash, Uint8Array>, set : Set<Hash>, progress? : Progress) {
      if(map.has(hash) || set.has(hash)) return true;
      const raw = await super.loadRaw(hash);
      if(!raw) return true;
      map.set(hash, raw);
      if(progress) progress(`Counting objects: ${map.size}\r`);
      return false;
    }

    private async getRefs(ref : string | string[]){
      const refs = Array.isArray(ref) ? ref : [ref];
      const pairs = await Promise.all(refs.map(async ref => ({
        ref,
        hash: await super.getRef(ref)
      })));
      const unknownRefs = pairs.filter(p => p.hash === undefined);
      if(unknownRefs.length > 0) throw new Error(`Unknown refs ${unknownRefs.map(p => p.ref).join(', ')}`);

      return pairs as RefHash[];
    }
  }
}

function makeCommand({ref, hash, remoteHash} : {ref : string, hash : string, remoteHash : string}) : Command{
  if(remoteHash === '00'){
    return {
      type: 'create',
      ref,
      hash
    };
  }

  return {
    type: 'update',
    ref,
    oldHash: remoteHash,
    newHash: hash
  };
}