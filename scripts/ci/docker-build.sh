#!/bin/sh
set -eu

image=''
tags=''
platforms=''
push='false'
cache_ref=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      image=$2
      shift 2
      ;;
    --tag)
      # Tags accumulate newline-delimited because POSIX sh has no arrays. A newline inside a tag
      # would split one tag into two, so refuse it rather than push something unintended. An empty
      # tag appends only a separator, so the accumulator stays non-empty while contributing no
      # field: the usage guard below would pass and the build would push under the wrong name.
      case "$2" in
        '')
          echo 'A tag cannot be empty.' >&2
          exit 64
          ;;
        *'
'*)
          echo 'A tag cannot contain a newline.' >&2
          exit 64
          ;;
      esac
      tags="$tags$2
"
      shift 2
      ;;
    --platforms)
      platforms=$2
      shift 2
      ;;
    --push)
      push='true'
      shift
      ;;
    --cache-ref)
      cache_ref=$2
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

if [ -z "$image" ] || [ -z "$tags" ]; then
  echo 'Usage: docker-build.sh --image <registry/repository> --tag <tag> [--tag <tag>]... [--platforms <list>] [--cache-ref <ref>] [--push]' >&2
  exit 64
fi

default_cache_ref="$image:buildcache"
[ -n "$cache_ref" ] || cache_ref=$default_cache_ref

# Build the buildx argv. `set --` runs after the option loop, because $@ holds this script's own
# arguments while that loop is reading them.
first_tag=''
set --
saved_ifs=$IFS
IFS='
'
# Field splitting is what turns the accumulator back into tags; pathname expansion is not wanted
# and would turn a tag holding a glob character into one --tag per matching file.
set -f
for tag in $tags; do
  case "$tag" in
    v[0-9]*) tag=${tag#v} ;;
  esac
  if [ -z "$first_tag" ]; then
    first_tag=$tag
  fi
  set -- "$@" --tag "$image:$tag"
done
set +f
IFS=$saved_ifs

revision=${GIT_SHA:-${CI_COMMIT_SHORT_SHA:-${GITHUB_SHA:-unknown}}}
# The first tag names the build. A release passes the version first, so the stamped version is
# 1.2.3 rather than the literal string `latest`.
version=${SRE_VERSION:-$first_tag}

if [ "$push" = 'true' ]; then
  if [ -z "$platforms" ]; then
    echo 'A pushed image requires --platforms.' >&2
    exit 64
  fi
  # Separate the write ref by trust level: a shared write ref lets any merge request publish a
  # blob under the key a later default-branch build imports. Reads stay one-way, so a lower-trust
  # build still warms from the default ref while writing only its own. image-manifest=true because
  # the GitLab registry rejects the default OCI manifest list for cache refs. Gated on --push: the
  # cache round-trips through the registry and needs the same credentials the push needs.
  set -- "$@" \
    --platform "$platforms" \
    --cache-from "type=registry,ref=$default_cache_ref"
  if [ "$cache_ref" != "$default_cache_ref" ]; then
    set -- "$@" --cache-from "type=registry,ref=$cache_ref"
  fi
  # Preserve provenance using attestation storage accepted by subject-strict registries.
  set -- "$@" \
    --cache-to "type=registry,ref=$cache_ref,mode=max,image-manifest=true" \
    --provenance=mode=min \
    --output type=image,push=true,oci-artifact=false
else
  case "$platforms" in
    *,*)
      echo 'A local image can load only one platform. Use --push for a multi-platform build.' >&2
      exit 64
      ;;
  esac
  if [ -n "$platforms" ]; then
    set -- "$@" --platform "$platforms"
  fi
  set -- "$@" --load
fi

docker buildx build \
  --file Dockerfile \
  --target production \
  --build-arg "SRE_VERSION=$version" \
  --build-arg "SRE_REVISION=$revision" \
  "$@" \
  .
