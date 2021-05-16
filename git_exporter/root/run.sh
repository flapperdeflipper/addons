#!/usr/bin/env bashio
set -e -o pipefail

# Enable Jemalloc for better memory handling
export LD_PRELOAD="/usr/local/lib/libjemalloc.so.2"

## The destination of the local repository
local_repository='/data/repository'

## Fetch remote changes before pushing new changes
pull_before_push="$( bashio::config repository.pull_before_push )"


function setup_git {
    username="$( bashio::config repository.username )"
    password="$( bashio::config repository.password )"

    repository="$( bashio::config repository.url )"
    committer_mail="$( bashio::config repository.email )"

    if [[ "$password" != "ghp_*" ]]; then
        password="$( python3 -c "import urllib.parse; print(urllib.parse.quote('${password}'))" )"
    fi

    if [ ! -d "$local_repository" ]; then
        bashio::log.info 'Create local repository'
        mkdir -p "$local_repository"
    fi

    cd "$local_repository"

    if [ ! -d .git ]; then
        full_url="https://${username}:${password}@${repository##*https://}"

        if [ "$pull_before_push" == 'true' ]; then
            bashio::log.info 'Clone existing repository'
            git clone "$full_url" "$local_repository"
        else
            bashio::log.info 'Initialize new repository'
            git init "$local_repository"
            git remote add origin "$full_url"
        fi

        git config user.name "${username}"
        git config user.email "${committer_mail:-git.exporter@home-assistant}"
    fi

    if [ "$pull_before_push" == 'true' ]; then
        bashio::log.info 'Pull latest'
        git fetch
        git reset --hard origin/master
    fi
}

function set_permissions {
    directory="${1}"

    [ ! -d "$directory" ] && {
        echo "Directory ${directory} not found!"
        exit 1
    }

    find "${directory}" -type d -exec chmod 750 {} \;
    find "${directory}" -type f -exec chmod 640 {} \;
}


function export_ha_config {
    bashio::log.info 'Get Home Assistant config'
    excludes="$( bashio::config exclude )"
    excludes=(
        "secrets.yaml"
        ".storage"
        ".cloud"
        "esphome/"
        ".uuid"
        "${excludes[@]}"
    )

    # Cleanup existing esphome folder from config
    [ -d "${local_repository}/config/esphome" ] && rm -rf "${local_repository}/config/esphome"

    # shellcheck disable=SC2068
    exclude_args="$( printf -- '--exclude=%s ' ${excludes[@]} )"

    # shellcheck disable=SC2086
    rsync \
        -q \
        -archive \
        --compress \
        --delete \
        --checksum \
        --prune-empty-dirs \
        --include='.gitignore' \
        $exclude_args \
        /config ${local_repository}

    sed 's/:.*$/: ""/g' /config/secrets.yaml > "${local_repository}/config/secrets.yaml"

    set_permissions "${local_repository}/config"
}


function export_lovelace {
    bashio::log.info 'Get Lovelace config yaml'

    mkdir -p '/tmp/lovelace' "${local_repository}/lovelace"
    find /config/.storage -name "lovelace*" -printf '%f\n' | xargs -I % cp /config/.storage/% /tmp/lovelace/%.json

    /utils/jsonToYaml.py '/tmp/lovelace/' 'data'

    rsync \
        -q \
        -archive \
        --compress --delete \
        --checksum \
        --prune-empty-dirs \
        --include='*.yaml' \
        --exclude='*' \
        /tmp/lovelace/ "${local_repository}/lovelace"

    set_permissions "${local_repository}/lovelace"
}


function export_esphome {
    bashio::log.info 'Get ESPHome configs'
    rsync \
        -q \
        -archive \
        --compress \
        --delete \
        --checksum \
        --prune-empty-dirs \
        --exclude='.esphome*' \
        --include='*/' \
        --include='.gitignore' \
        --include='*.yaml' \
        --include='*.disabled' \
        --exclude='secrets.yaml' \
        --exclude='*' \
        /config/esphome "${local_repository}"

    [ -f /config/esphome/secrets.yaml ] && {
        sed 's/:.*$/: ""/g' /config/esphome/secrets.yaml > "${local_repository}/esphome/secrets.yaml";
    }

    set_permissions "${local_repository}/esphome"
}


function export_addons {
    mkdir -p "${local_repository}/addons" /tmp/addons

    installed_addons="$( bashio::addons.installed )"

    for addon in $installed_addons
    do
        if [ "$(bashio::addons.installed "${addon}")" == 'true' ]
        then
            bashio::log.info "Get ${addon} configs"

            bashio::addon.options "${addon}" >  /tmp/tmp.json

            /utils/jsonToYaml.py /tmp/tmp.json

            mv /tmp/tmp.yaml "/tmp/addons/${addon}.yaml"
        fi
    done

    bashio::log.info "Get addon repositories"
    bashio::addons false 'addons.repositories' '.repositories | map(select(.source != null)) | map({(.name): {source,maintainer,slug}}) | add' > /tmp/tmp.json

    /utils/jsonToYaml.py /tmp/tmp.json

    mv /tmp/tmp.yaml "/tmp/addons/repositories.yaml"

    rsync \
        -q \
        -archive \
        --compress \
        --delete \
        --checksum \
        --prune-empty-dirs \
        /tmp/addons/ "${local_repository}/addons"

    set_permissions "${local_repository}/addons"
}


function main {
    bashio::log.info 'Start git export'

    setup_git
    export_ha_config

    if [ "$( bashio::config export.lovelace )" == 'true' ]; then
        export_lovelace
    fi

    if [ "$( bashio::config export.esphome )" == 'true' ] && [ -d '/config/esphome' ]; then
        export_esphome
    fi

    if [ "$( bashio::config export.addons )" == 'true' ]; then
        export_addons
    fi

    if [ "$( bashio::config dry_run )" == 'true' ]; then
        git status
    else
        bashio::log.info 'Commit changes and push to remote'

        git add .
        git commit -m "$( bashio::config repository.commit_message )"

        if [ ! "$pull_before_push" == 'true' ]; then
            git push --set-upstream origin master -f
        else
            git push origin
        fi
    fi

    bashio::log.info 'Exporter finished'
}


main
