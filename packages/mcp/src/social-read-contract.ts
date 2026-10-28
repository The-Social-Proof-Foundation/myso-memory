// Generated from the social-server response types. These reads are public indexer evidence. A caller-supplied address filters the query and is not the authenticated principal.
export const SOCIAL_READ_CONTRACTS = {
  "social_list_subscriptions": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "subscription_id": {
        "nullable": false,
        "kind": "string"
      },
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_id": {
        "nullable": false,
        "kind": "string"
      },
      "tier_level": {
        "nullable": true,
        "kind": "int"
      },
      "platform_id": {
        "nullable": true,
        "kind": "string"
      },
      "price": {
        "nullable": false,
        "kind": "int"
      },
      "duration_ms": {
        "nullable": false,
        "kind": "int"
      },
      "subscriber": {
        "nullable": false,
        "kind": "address"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "expires_at": {
        "nullable": false,
        "kind": "int"
      },
      "auto_renew": {
        "nullable": false,
        "kind": "bool"
      },
      "renewal_balance": {
        "nullable": false,
        "kind": "int"
      },
      "renewal_count": {
        "nullable": false,
        "kind": "int"
      },
      "cancelled_at": {
        "nullable": true,
        "kind": "int"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_list_subscription_services": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_count": {
        "nullable": false,
        "kind": "int"
      },
      "active": {
        "nullable": false,
        "kind": "bool"
      },
      "subscriber_count": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      },
      "payment_recipient": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_list_subscription_revenue": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "subscription_id": {
        "nullable": true,
        "kind": "string"
      },
      "from_address": {
        "nullable": false,
        "kind": "address"
      },
      "to_address": {
        "nullable": false,
        "kind": "address"
      },
      "amount": {
        "nullable": false,
        "kind": "int"
      },
      "platform_fee": {
        "nullable": false,
        "kind": "int"
      },
      "ecosystem_fee": {
        "nullable": false,
        "kind": "int"
      },
      "creator_amount": {
        "nullable": false,
        "kind": "int"
      },
      "platform_address": {
        "nullable": true,
        "kind": "address"
      },
      "revenue_type": {
        "nullable": false,
        "kind": "string"
      },
      "payment_time": {
        "nullable": false,
        "kind": "int"
      },
      "time": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_get_subscription_status": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "subscription_id",
      "service_id",
      "active",
      "expires_at",
      "cancelled_at"
    ]
  },
  "social_get_subscriber_summary": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "active_subscriptions": {
        "nullable": false,
        "kind": "int"
      },
      "total_revenue": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_profile_subscription_services": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_count": {
        "nullable": false,
        "kind": "int"
      },
      "active": {
        "nullable": false,
        "kind": "bool"
      },
      "subscriber_count": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      },
      "payment_recipient": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_get_subscription_service": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_count": {
        "nullable": false,
        "kind": "int"
      },
      "active": {
        "nullable": false,
        "kind": "bool"
      },
      "subscriber_count": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      },
      "payment_recipient": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_list_subscription_plans": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "plan_id": {
        "nullable": false,
        "kind": "string"
      },
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "title": {
        "nullable": false,
        "kind": "string"
      },
      "description": {
        "nullable": true,
        "kind": "string"
      },
      "price": {
        "nullable": false,
        "kind": "int"
      },
      "duration_ms": {
        "nullable": false,
        "kind": "int"
      },
      "tier_level": {
        "nullable": true,
        "kind": "int"
      },
      "platform_id": {
        "nullable": true,
        "kind": "string"
      },
      "active": {
        "nullable": false,
        "kind": "bool"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_service_subscription_revenue": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "subscription_id": {
        "nullable": true,
        "kind": "string"
      },
      "from_address": {
        "nullable": false,
        "kind": "address"
      },
      "to_address": {
        "nullable": false,
        "kind": "address"
      },
      "amount": {
        "nullable": false,
        "kind": "int"
      },
      "platform_fee": {
        "nullable": false,
        "kind": "int"
      },
      "ecosystem_fee": {
        "nullable": false,
        "kind": "int"
      },
      "creator_amount": {
        "nullable": false,
        "kind": "int"
      },
      "platform_address": {
        "nullable": true,
        "kind": "address"
      },
      "revenue_type": {
        "nullable": false,
        "kind": "string"
      },
      "payment_time": {
        "nullable": false,
        "kind": "int"
      },
      "time": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_list_subscriptions_by_subscriber": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "subscription_id": {
        "nullable": false,
        "kind": "string"
      },
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_id": {
        "nullable": false,
        "kind": "string"
      },
      "tier_level": {
        "nullable": true,
        "kind": "int"
      },
      "platform_id": {
        "nullable": true,
        "kind": "string"
      },
      "price": {
        "nullable": false,
        "kind": "int"
      },
      "duration_ms": {
        "nullable": false,
        "kind": "int"
      },
      "subscriber": {
        "nullable": false,
        "kind": "address"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "expires_at": {
        "nullable": false,
        "kind": "int"
      },
      "auto_renew": {
        "nullable": false,
        "kind": "bool"
      },
      "renewal_balance": {
        "nullable": false,
        "kind": "int"
      },
      "renewal_count": {
        "nullable": false,
        "kind": "int"
      },
      "cancelled_at": {
        "nullable": true,
        "kind": "int"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_get_subscription": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "subscription_id": {
        "nullable": false,
        "kind": "string"
      },
      "service_id": {
        "nullable": false,
        "kind": "string"
      },
      "plan_id": {
        "nullable": false,
        "kind": "string"
      },
      "tier_level": {
        "nullable": true,
        "kind": "int"
      },
      "platform_id": {
        "nullable": true,
        "kind": "string"
      },
      "price": {
        "nullable": false,
        "kind": "int"
      },
      "duration_ms": {
        "nullable": false,
        "kind": "int"
      },
      "subscriber": {
        "nullable": false,
        "kind": "address"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "expires_at": {
        "nullable": false,
        "kind": "int"
      },
      "auto_renew": {
        "nullable": false,
        "kind": "bool"
      },
      "renewal_balance": {
        "nullable": false,
        "kind": "int"
      },
      "renewal_count": {
        "nullable": false,
        "kind": "int"
      },
      "cancelled_at": {
        "nullable": true,
        "kind": "int"
      },
      "profile_owner": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_check_subscription_access": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "has_access"
    ]
  },
  "social_get_subscription_analytics": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "analytics",
      "period_start",
      "period_end"
    ]
  },
  "social_get_service_performance": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "total_count",
      "services"
    ]
  },
  "social_get_subscription_configuration": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "updated_by": {
        "nullable": false,
        "kind": "string"
      },
      "default_billing_period_ms": {
        "nullable": false,
        "kind": "int"
      },
      "max_renewal_months": {
        "nullable": false,
        "kind": "int"
      },
      "platform_fee_bps": {
        "nullable": false,
        "kind": "int"
      },
      "ecosystem_fee_bps": {
        "nullable": false,
        "kind": "int"
      },
      "non_platform_platform_to_creator_bps": {
        "nullable": false,
        "kind": "int"
      },
      "non_platform_platform_to_treasury_bps": {
        "nullable": false,
        "kind": "int"
      },
      "version": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_governance_proposals": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "id": { "nullable": false, "kind": "string" },
      "title": { "nullable": false, "kind": "string" },
      "description": { "nullable": false, "kind": "string" },
      "proposal_type": { "nullable": false, "kind": "int" },
      "reference_id": { "nullable": true, "kind": "string" },
      "metadata_json": { "nullable": true, "kind": "json" },
      "submitter": { "nullable": false, "kind": "address" },
      "submission_time": { "nullable": false, "kind": "int" },
      "delegate_approval_count": { "nullable": false, "kind": "quantity" },
      "delegate_rejection_count": { "nullable": false, "kind": "quantity" },
      "community_votes_for": { "nullable": false, "kind": "quantity" },
      "community_votes_against": { "nullable": false, "kind": "quantity" },
      "status": { "nullable": false, "kind": "int" },
      "voting_start_time": { "nullable": true, "kind": "int" },
      "voting_end_time": { "nullable": true, "kind": "int" },
      "reward_pool": { "nullable": false, "kind": "quantity" },
      "implemented_description": { "nullable": true, "kind": "string" },
      "implementation_time": { "nullable": true, "kind": "int" },
      "rescind_time": { "nullable": true, "kind": "int" },
      "rejection_time": { "nullable": true, "kind": "int" },
      "anonymous_voters_count": { "nullable": true, "kind": "quantity" },
      "governance_registry_id": { "nullable": false, "kind": "string" }
    }
  },
  "social_search": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "profiles",
      "posts",
      "platforms",
      "platforms_count"
    ]
  },
  "social_list_profiles": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "profiles",
      "pagination",
      "total",
      "limit",
      "offset",
      "page",
      "total_pages"
    ]
  },
  "social_get_daily_stats": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "chart_data": {
        "nullable": false,
        "kind": {
          "array": {
            "day": {
              "nullable": false,
              "kind": "string"
            },
            "event_type": {
              "nullable": false,
              "kind": "string"
            },
            "event_count": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      },
      "date_range": {
        "nullable": false,
        "kind": {
          "object": {
            "start_date": {
              "nullable": false,
              "kind": "string"
            },
            "end_date": {
              "nullable": false,
              "kind": "string"
            },
            "days": {
              "nullable": false,
              "kind": "int"
            },
            "bucket": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      },
      "summary": {
        "nullable": false,
        "kind": {
          "object": {
            "total_profile_created": {
              "nullable": false,
              "kind": "int"
            },
            "total_profile_updated": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_get_graph_chart_data": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "chart_data": {
        "nullable": false,
        "kind": {
          "array": {
            "day": {
              "nullable": false,
              "kind": "string"
            },
            "event_type": {
              "nullable": false,
              "kind": "string"
            },
            "event_count": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      },
      "date_range": {
        "nullable": false,
        "kind": {
          "object": {
            "start_date": {
              "nullable": false,
              "kind": "string"
            },
            "end_date": {
              "nullable": false,
              "kind": "string"
            },
            "days": {
              "nullable": false,
              "kind": "int"
            },
            "bucket": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      },
      "summary": {
        "nullable": false,
        "kind": {
          "object": {
            "total_follows": {
              "nullable": false,
              "kind": "int"
            },
            "total_unfollows": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_list_posts": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_trending_posts": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_get_post": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_comments": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "comment_id": {
        "nullable": false,
        "kind": "address"
      },
      "post_id": {
        "nullable": false,
        "kind": "address"
      },
      "parent_comment_id": {
        "nullable": true,
        "kind": "address"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_reactions": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "user_address": {
        "nullable": false,
        "kind": "address"
      },
      "reaction_text": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "principal_owner": {
        "nullable": true,
        "kind": "address"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_reposts": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_get_post_promotion": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_poc_badges": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_revenue_redirections": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_transfers": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_reports": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_moderation_events": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_post_deletion_events": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_profile_posts": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "post_id": {
        "nullable": false,
        "kind": "string"
      },
      "owner": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "content": {
        "nullable": false,
        "kind": "string"
      },
      "post_type": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "int"
      },
      "reaction_count": {
        "nullable": false,
        "kind": "int"
      },
      "comment_count": {
        "nullable": false,
        "kind": "int"
      },
      "repost_count": {
        "nullable": false,
        "kind": "int"
      },
      "tips_received": {
        "nullable": false,
        "kind": "int"
      },
      "total_tip_volume": {
        "nullable": false,
        "kind": "int"
      },
      "media_urls": {
        "nullable": true,
        "kind": "json"
      },
      "mentions": {
        "nullable": true,
        "kind": "json"
      },
      "parent_post_id": {
        "nullable": true,
        "kind": "string"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_to": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_redirect_percentage": {
        "nullable": true,
        "kind": "int"
      },
      "poc_reasoning": {
        "nullable": true,
        "kind": "string"
      },
      "poc_evidence_urls": {
        "nullable": true,
        "kind": "json"
      },
      "poc_similarity_score": {
        "nullable": true,
        "kind": "int"
      },
      "poc_media_type": {
        "nullable": true,
        "kind": "int"
      },
      "poc_oracle_address": {
        "nullable": true,
        "kind": "address"
      },
      "poc_analyzed_at": {
        "nullable": true,
        "kind": "int"
      },
      "poc_outcome": {
        "nullable": true,
        "kind": "int"
      },
      "poc_redirection_kind": {
        "nullable": true,
        "kind": "int"
      },
      "poc_disputes_submitted": {
        "nullable": false,
        "kind": "int"
      },
      "enable_spt": {
        "nullable": false,
        "kind": "bool"
      },
      "spt_id": {
        "nullable": true,
        "kind": "string"
      },
      "mydata_id": {
        "nullable": true,
        "kind": "string"
      },
      "revenue_recipient": {
        "nullable": true,
        "kind": "string"
      },
      "requires_subscription": {
        "nullable": true,
        "kind": "bool"
      },
      "subscription_service_id": {
        "nullable": true,
        "kind": "string"
      },
      "subscription_price": {
        "nullable": true,
        "kind": "int"
      },
      "subscription_min_tier_level": {
        "nullable": true,
        "kind": "int"
      },
      "encrypted_content_hash": {
        "nullable": true,
        "kind": "string"
      },
      "removed_from_platform": {
        "nullable": true,
        "kind": "bool"
      },
      "removed_by": {
        "nullable": true,
        "kind": "string"
      },
      "metadata_json": {
        "nullable": true,
        "kind": "json"
      },
      "promotion_id": {
        "nullable": true,
        "kind": "string"
      },
      "platform_id": {
        "nullable": true,
        "kind": "string"
      },
      "permissions": {
        "nullable": true,
        "kind": "int"
      },
      "actor_address": {
        "nullable": true,
        "kind": "address"
      },
      "sub_agent_id": {
        "nullable": true,
        "kind": "string"
      },
      "action_identity_class": {
        "nullable": true,
        "kind": "int"
      },
      "organization_id": {
        "nullable": true,
        "kind": "string"
      },
      "post_access_kind": {
        "nullable": true,
        "kind": "string"
      },
      "contract_version": {
        "nullable": false,
        "kind": "int"
      },
      "composition_status": {
        "nullable": true,
        "kind": "int"
      },
      "monetization_status": {
        "nullable": true,
        "kind": "int"
      },
      "media_asset_ids": {
        "nullable": true,
        "kind": "json"
      },
      "embedded_bindings": {
        "nullable": true,
        "kind": "json"
      },
      "usage_decisions": {
        "nullable": true,
        "kind": "json"
      },
      "usage_denials": {
        "nullable": true,
        "kind": "json"
      }
    }
  },
  "social_get_profile": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "id": {
        "nullable": true,
        "kind": "int"
      },
      "owner_address": {
        "nullable": false,
        "kind": "address"
      },
      "profile_id": {
        "nullable": true,
        "kind": "string"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "bio": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "website": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": true,
        "kind": "int"
      },
      "updated_at": {
        "nullable": true,
        "kind": "int"
      },
      "followers_count": {
        "nullable": false,
        "kind": "int"
      },
      "following_count": {
        "nullable": false,
        "kind": "int"
      },
      "post_count": {
        "nullable": false,
        "kind": "int"
      },
      "birthdate": {
        "nullable": true,
        "kind": "string"
      },
      "location": {
        "nullable": true,
        "kind": "string"
      },
      "x_username": {
        "nullable": true,
        "kind": "string"
      },
      "block_list_address": {
        "nullable": true,
        "kind": "address"
      },
      "social_proof_token_address": {
        "nullable": true,
        "kind": "address"
      },
      "reservation_pool_address": {
        "nullable": true,
        "kind": "address"
      },
      "social_proof_token": {
        "nullable": true,
        "kind": {
          "object": {
            "pool_id": {
              "nullable": true,
              "kind": "string"
            },
            "token_address": {
              "nullable": true,
              "kind": "address"
            },
            "is_active": {
              "nullable": false,
              "kind": "bool"
            },
            "reservation_pool_id": {
              "nullable": true,
              "kind": "string"
            },
            "reservation_percentage": {
              "nullable": false,
              "kind": "float"
            },
            "reservation_status": {
              "nullable": false,
              "kind": "string"
            },
            "total_reserved": {
              "nullable": false,
              "kind": "int"
            },
            "required_threshold": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      },
      "selected_badge": {
        "nullable": true,
        "kind": {
          "object": {
            "badge_id": {
              "nullable": false,
              "kind": "string"
            },
            "badge_name": {
              "nullable": false,
              "kind": "string"
            },
            "badge_icon_url": {
              "nullable": true,
              "kind": "string"
            },
            "badge_media_url": {
              "nullable": true,
              "kind": "string"
            },
            "platform_id": {
              "nullable": false,
              "kind": "string"
            },
            "badge_type": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      },
      "selected_badge_id": {
        "nullable": true,
        "kind": "string"
      },
      "selected_ecosystem_badge_id": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_get_profile_by_username": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "id": {
        "nullable": false,
        "kind": "int"
      },
      "owner_address": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": false,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "bio": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      },
      "website": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "profile_id": {
        "nullable": true,
        "kind": "string"
      },
      "followers_count": {
        "nullable": false,
        "kind": "int"
      },
      "following_count": {
        "nullable": false,
        "kind": "int"
      },
      "blocked_count": {
        "nullable": false,
        "kind": "int"
      },
      "post_count": {
        "nullable": false,
        "kind": "int"
      },
      "birthdate": {
        "nullable": true,
        "kind": "string"
      },
      "location": {
        "nullable": true,
        "kind": "string"
      },
      "x_username": {
        "nullable": true,
        "kind": "string"
      },
      "social_proof_token_address": {
        "nullable": true,
        "kind": "address"
      },
      "reservation_pool_address": {
        "nullable": true,
        "kind": "address"
      },
      "selected_badge_id": {
        "nullable": true,
        "kind": "string"
      },
      "selected_ecosystem_badge_id": {
        "nullable": true,
        "kind": "string"
      },
      "memory_account_id": {
        "nullable": true,
        "kind": "string"
      },
      "ai_credit_balance_id": {
        "nullable": true,
        "kind": "string"
      },
      "contract_version": {
        "nullable": false,
        "kind": "int"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "timestamp"
      }
    }
  },
  "social_list_profile_followers": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "profiles",
      "pagination"
    ]
  },
  "social_list_profile_following": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "profiles",
      "pagination"
    ]
  },
  "social_list_profile_blocked": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "blocked_address": {
        "nullable": false,
        "kind": "address"
      },
      "blocked_username": {
        "nullable": false,
        "kind": "string"
      },
      "blocked_display_name": {
        "nullable": true,
        "kind": "string"
      },
      "blocked_profile_photo": {
        "nullable": true,
        "kind": "string"
      },
      "first_blocked_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "last_blocked_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_list_profile_blocked_platforms": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "name": {
        "nullable": false,
        "kind": "string"
      },
      "blocked_by": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_list_profile_blocking_history": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "event_type": {
        "nullable": false,
        "kind": "blockEvent"
      },
      "blocked_address": {
        "nullable": true,
        "kind": "address"
      },
      "processed_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "event_id": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_list_username_offers": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "id": {
        "nullable": false,
        "kind": "int"
      },
      "username": {
        "nullable": false,
        "kind": "string"
      },
      "seller_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "buyer_address": {
        "nullable": false,
        "kind": "address"
      },
      "buyer_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "amount": {
        "nullable": false,
        "kind": "int"
      },
      "status": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "int"
      },
      "resolved_at": {
        "nullable": true,
        "kind": "int"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      },
      "time": {
        "nullable": false,
        "kind": "json"
      }
    }
  },
  "social_list_profile_username_offers": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "id": {
        "nullable": false,
        "kind": "int"
      },
      "username": {
        "nullable": false,
        "kind": "string"
      },
      "seller_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "buyer_address": {
        "nullable": false,
        "kind": "address"
      },
      "buyer_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "amount": {
        "nullable": false,
        "kind": "int"
      },
      "status": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "int"
      },
      "resolved_at": {
        "nullable": true,
        "kind": "int"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      },
      "time": {
        "nullable": false,
        "kind": "json"
      }
    }
  },
  "social_list_profile_username_sale_fees": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "id": {
        "nullable": false,
        "kind": "int"
      },
      "username": {
        "nullable": false,
        "kind": "string"
      },
      "seller_address": {
        "nullable": false,
        "kind": "address"
      },
      "seller_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "buyer_address": {
        "nullable": false,
        "kind": "address"
      },
      "buyer_profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "sale_amount": {
        "nullable": false,
        "kind": "int"
      },
      "fee_amount": {
        "nullable": false,
        "kind": "int"
      },
      "fee_recipient_address": {
        "nullable": false,
        "kind": "address"
      },
      "timestamp": {
        "nullable": false,
        "kind": "int"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      },
      "time": {
        "nullable": false,
        "kind": "json"
      }
    }
  },
  "social_check_following": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "is_following",
      "following_back"
    ]
  },
  "social_check_profile_blocked": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "is_following",
      "following_back"
    ]
  },
  "social_check_either_profile_blocked": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "is_following",
      "following_back"
    ]
  },
  "social_check_platform_blocked": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "is_following",
      "following_back"
    ]
  },
  "social_list_profile_badges": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "badge_id": {
        "nullable": false,
        "kind": "string"
      },
      "badge_name": {
        "nullable": false,
        "kind": "string"
      },
      "badge_description": {
        "nullable": true,
        "kind": "string"
      },
      "badge_media_url": {
        "nullable": true,
        "kind": "string"
      },
      "badge_icon_url": {
        "nullable": true,
        "kind": "string"
      },
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "assigned_by": {
        "nullable": false,
        "kind": "string"
      },
      "assigned_at": {
        "nullable": false,
        "kind": "int"
      },
      "revoked": {
        "nullable": false,
        "kind": "bool"
      },
      "revoked_at": {
        "nullable": true,
        "kind": "int"
      },
      "revoked_by": {
        "nullable": true,
        "kind": "string"
      },
      "badge_type": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_get_profile_stats": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "profile_id": {
        "nullable": true,
        "kind": "string"
      },
      "wallet_address": {
        "nullable": false,
        "kind": "address"
      },
      "username": {
        "nullable": true,
        "kind": "string"
      },
      "display_name": {
        "nullable": true,
        "kind": "string"
      },
      "profile_photo": {
        "nullable": true,
        "kind": "string"
      },
      "followers_count": {
        "nullable": false,
        "kind": "int"
      },
      "following_count": {
        "nullable": false,
        "kind": "int"
      },
      "blocked_count": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_check_follow_relationship": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "is_following",
      "following_back"
    ]
  },
  "social_get_profile_pnl": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "window": {
        "nullable": false,
        "kind": "string"
      },
      "swap_net_myso": {
        "nullable": false,
        "kind": "int"
      },
      "reservation_net_myso": {
        "nullable": false,
        "kind": "int"
      },
      "spt_creator_fees_myso": {
        "nullable": false,
        "kind": "int"
      },
      "tips_myso": {
        "nullable": false,
        "kind": "int"
      },
      "subscriptions_myso": {
        "nullable": false,
        "kind": "int"
      },
      "mydata_myso": {
        "nullable": false,
        "kind": "int"
      },
      "posts_monetization_myso": {
        "nullable": false,
        "kind": "int"
      },
      "messaging_myso": {
        "nullable": false,
        "kind": "int"
      },
      "username_marketplace_myso": {
        "nullable": false,
        "kind": "int"
      },
      "other_inbound_myso": {
        "nullable": false,
        "kind": "int"
      },
      "gross_inbound_myso": {
        "nullable": false,
        "kind": "int"
      },
      "net_cash_flow_myso": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_profile_recommendations": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "recommendations",
      "pagination"
    ]
  },
  "social_list_profile_events": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "event_type": {
        "nullable": false,
        "kind": "string"
      },
      "profile_id": {
        "nullable": false,
        "kind": "string"
      },
      "event_data": {
        "nullable": false,
        "kind": "json"
      },
      "event_id": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_list_profile_platform_memberships": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "membership_id": {
        "nullable": false,
        "kind": "int"
      },
      "joined_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "platform_db_id": {
        "nullable": false,
        "kind": "int"
      },
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "name": {
        "nullable": false,
        "kind": "string"
      },
      "tagline": {
        "nullable": false,
        "kind": "string"
      },
      "description": {
        "nullable": true,
        "kind": "string"
      },
      "logo": {
        "nullable": true,
        "kind": "string"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "media_previews": {
        "nullable": true,
        "kind": "json"
      },
      "developer_address": {
        "nullable": false,
        "kind": "address"
      },
      "moderators_group_id": {
        "nullable": true,
        "kind": "string"
      },
      "terms_of_service": {
        "nullable": true,
        "kind": "string"
      },
      "privacy_policy": {
        "nullable": true,
        "kind": "string"
      },
      "redirect_uri": {
        "nullable": true,
        "kind": "string"
      },
      "platform_names": {
        "nullable": true,
        "kind": "json"
      },
      "links": {
        "nullable": true,
        "kind": "json"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "release_date": {
        "nullable": true,
        "kind": "string"
      },
      "shutdown_date": {
        "nullable": true,
        "kind": "string"
      },
      "platform_created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "platform_updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "is_approved": {
        "nullable": false,
        "kind": "bool"
      },
      "approval_changed_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "approved_by": {
        "nullable": true,
        "kind": "string"
      },
      "wants_dao_governance": {
        "nullable": true,
        "kind": "bool"
      },
      "governance_registry_id": {
        "nullable": true,
        "kind": "string"
      },
      "delegate_count": {
        "nullable": true,
        "kind": "int"
      },
      "delegate_term_epochs": {
        "nullable": true,
        "kind": "int"
      },
      "max_votes_per_user": {
        "nullable": true,
        "kind": "int"
      },
      "proposal_submission_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quadratic_base_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quorum_votes": {
        "nullable": true,
        "kind": "int"
      },
      "voting_period_epochs": {
        "nullable": true,
        "kind": "int"
      },
      "version": {
        "nullable": true,
        "kind": "int"
      },
      "primary_category": {
        "nullable": false,
        "kind": "string"
      },
      "secondary_category": {
        "nullable": true,
        "kind": "string"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "moderator_count": {
        "nullable": false,
        "kind": "int"
      },
      "blocked_profiles_count": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_profile_platform_events": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "events",
      "total"
    ]
  },
  "social_list_approved_platforms": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "name": {
        "nullable": false,
        "kind": "string"
      },
      "tagline": {
        "nullable": false,
        "kind": "string"
      },
      "description": {
        "nullable": true,
        "kind": "string"
      },
      "logo": {
        "nullable": true,
        "kind": "string"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "media_previews": {
        "nullable": true,
        "kind": "json"
      },
      "developer_address": {
        "nullable": false,
        "kind": "address"
      },
      "moderators_group_id": {
        "nullable": true,
        "kind": "string"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "is_approved": {
        "nullable": false,
        "kind": "bool"
      },
      "primary_category": {
        "nullable": false,
        "kind": "string"
      },
      "secondary_category": {
        "nullable": true,
        "kind": "string"
      },
      "redirect_uri": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "wants_dao_governance": {
        "nullable": true,
        "kind": "bool"
      },
      "governance_registry_id": {
        "nullable": true,
        "kind": "string"
      },
      "delegate_count": {
        "nullable": true,
        "kind": "int"
      },
      "delegate_term_epochs": {
        "nullable": true,
        "kind": "int"
      },
      "max_votes_per_user": {
        "nullable": true,
        "kind": "int"
      },
      "proposal_submission_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quadratic_base_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quorum_votes": {
        "nullable": true,
        "kind": "int"
      },
      "voting_period_epochs": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_platforms": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "name": {
        "nullable": false,
        "kind": "string"
      },
      "tagline": {
        "nullable": false,
        "kind": "string"
      },
      "description": {
        "nullable": true,
        "kind": "string"
      },
      "logo": {
        "nullable": true,
        "kind": "string"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "media_previews": {
        "nullable": true,
        "kind": "json"
      },
      "developer_address": {
        "nullable": false,
        "kind": "address"
      },
      "moderators_group_id": {
        "nullable": true,
        "kind": "string"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "is_approved": {
        "nullable": false,
        "kind": "bool"
      },
      "primary_category": {
        "nullable": false,
        "kind": "string"
      },
      "secondary_category": {
        "nullable": true,
        "kind": "string"
      },
      "redirect_uri": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "wants_dao_governance": {
        "nullable": true,
        "kind": "bool"
      },
      "governance_registry_id": {
        "nullable": true,
        "kind": "string"
      },
      "delegate_count": {
        "nullable": true,
        "kind": "int"
      },
      "delegate_term_epochs": {
        "nullable": true,
        "kind": "int"
      },
      "max_votes_per_user": {
        "nullable": true,
        "kind": "int"
      },
      "proposal_submission_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quadratic_base_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quorum_votes": {
        "nullable": true,
        "kind": "int"
      },
      "voting_period_epochs": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_get_platform": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "name": {
        "nullable": false,
        "kind": "string"
      },
      "tagline": {
        "nullable": false,
        "kind": "string"
      },
      "description": {
        "nullable": true,
        "kind": "string"
      },
      "logo": {
        "nullable": true,
        "kind": "string"
      },
      "cover_photo": {
        "nullable": true,
        "kind": "string"
      },
      "media_previews": {
        "nullable": true,
        "kind": "json"
      },
      "developer_address": {
        "nullable": false,
        "kind": "address"
      },
      "moderators_group_id": {
        "nullable": true,
        "kind": "string"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "is_approved": {
        "nullable": false,
        "kind": "bool"
      },
      "primary_category": {
        "nullable": false,
        "kind": "string"
      },
      "secondary_category": {
        "nullable": true,
        "kind": "string"
      },
      "redirect_uri": {
        "nullable": true,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "deleted_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "wants_dao_governance": {
        "nullable": true,
        "kind": "bool"
      },
      "governance_registry_id": {
        "nullable": true,
        "kind": "string"
      },
      "delegate_count": {
        "nullable": true,
        "kind": "int"
      },
      "delegate_term_epochs": {
        "nullable": true,
        "kind": "int"
      },
      "max_votes_per_user": {
        "nullable": true,
        "kind": "int"
      },
      "proposal_submission_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quadratic_base_cost": {
        "nullable": true,
        "kind": "int"
      },
      "quorum_votes": {
        "nullable": true,
        "kind": "int"
      },
      "voting_period_epochs": {
        "nullable": true,
        "kind": "int"
      }
    }
  },
  "social_list_platform_members": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "wallet_address": {
        "nullable": false,
        "kind": "address"
      },
      "joined_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_get_platform_approval": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "is_approved": {
        "nullable": false,
        "kind": "bool"
      },
      "approval_changed_at": {
        "nullable": true,
        "kind": "timestamp"
      },
      "approved_by": {
        "nullable": true,
        "kind": "string"
      }
    }
  },
  "social_get_platform_user_access": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "is_member": {
        "nullable": false,
        "kind": "bool"
      },
      "is_blocked": {
        "nullable": false,
        "kind": "bool"
      },
      "is_moderator": {
        "nullable": false,
        "kind": "bool"
      },
      "moderator_permissions": {
        "nullable": false,
        "kind": "strings"
      },
      "can_block_users": {
        "nullable": false,
        "kind": "bool"
      },
      "can_moderate_content": {
        "nullable": false,
        "kind": "bool"
      },
      "can_manage_badges": {
        "nullable": false,
        "kind": "bool"
      },
      "can_withdraw_from_platform_treasury": {
        "nullable": false,
        "kind": "bool"
      },
      "can_manage_promotions": {
        "nullable": false,
        "kind": "bool"
      }
    }
  },
  "social_check_platform_membership": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "is_member": {
        "nullable": false,
        "kind": "bool"
      },
      "is_blocked": {
        "nullable": false,
        "kind": "bool"
      },
      "is_moderator": {
        "nullable": false,
        "kind": "bool"
      },
      "moderator_permissions": {
        "nullable": false,
        "kind": "strings"
      },
      "can_block_users": {
        "nullable": false,
        "kind": "bool"
      },
      "can_moderate_content": {
        "nullable": false,
        "kind": "bool"
      },
      "can_manage_badges": {
        "nullable": false,
        "kind": "bool"
      },
      "can_withdraw_from_platform_treasury": {
        "nullable": false,
        "kind": "bool"
      },
      "can_manage_promotions": {
        "nullable": false,
        "kind": "bool"
      }
    }
  },
  "social_list_platform_blocked_profiles": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "wallet_address": {
        "nullable": false,
        "kind": "address"
      },
      "blocked_by": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_get_platform_treasury": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "balance_mist": {
        "nullable": false,
        "kind": "int"
      },
      "last_funded_at": {
        "nullable": true,
        "kind": "int"
      },
      "last_withdrawn_at": {
        "nullable": true,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_list_platform_treasury_withdrawals": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "platform_id": {
        "nullable": false,
        "kind": "string"
      },
      "balance_mist": {
        "nullable": false,
        "kind": "int"
      },
      "last_funded_at": {
        "nullable": true,
        "kind": "int"
      },
      "last_withdrawn_at": {
        "nullable": true,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      }
    }
  },
  "social_get_revenue_dashboard": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "revenue_source",
      "total_revenue",
      "transaction_count",
      "percentage_of_total",
      "growth_rate"
    ]
  },
  "social_list_revenue_leaderboard": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "leaderboard",
      "min_revenue",
      "limit"
    ]
  },
  "social_get_revenue_chart": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "chart_data",
      "period",
      "start_date",
      "end_date"
    ]
  },
  "social_list_unified_revenue": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "revenue_records",
      "total_count",
      "total_amount",
      "total_amount_formatted",
      "pagination",
      "total",
      "limit",
      "offset",
      "page",
      "total_pages"
    ]
  },
  "social_get_creator_revenue_stats": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "creator_address",
      "total_revenue",
      "subscription_revenue",
      "mydata_revenue",
      "spt_revenue",
      "tips_revenue",
      "posts_revenue",
      "total_transactions",
      "unique_payers",
      "largest_transaction",
      "active_days",
      "last_revenue_date",
      "revenue_rank"
    ]
  },
  "social_get_platform_revenue_stats": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "creator_address",
      "total_revenue",
      "subscription_revenue",
      "mydata_revenue",
      "spt_revenue",
      "tips_revenue",
      "posts_revenue",
      "total_transactions",
      "unique_payers",
      "largest_transaction",
      "active_days",
      "last_revenue_date",
      "revenue_rank"
    ]
  },
  "social_get_treasury_current": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "nullable": true,
    "keys": [
      "treasury_address",
      "updated_by",
      "updated_at",
      "time",
      "transaction_id"
    ]
  },
  "social_list_treasury_history": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "history",
      "count"
    ]
  },
  "social_get_messaging_configuration": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "updated_by": {
        "nullable": false,
        "kind": "string"
      },
      "paid_msg_platform_fee_bps": {
        "nullable": false,
        "kind": "int"
      },
      "paid_msg_treasury_fee_bps": {
        "nullable": false,
        "kind": "int"
      },
      "payment_expiration_ms": {
        "nullable": false,
        "kind": "int"
      },
      "min_reply_chars": {
        "nullable": false,
        "kind": "int"
      },
      "max_dedupe_key_bytes": {
        "nullable": false,
        "kind": "int"
      },
      "updated_at": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_get_insurance_configuration": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "pricing": {
        "nullable": false,
        "kind": {
          "object": {
            "updated_by": {
              "nullable": false,
              "kind": "string"
            },
            "insurance_enabled": {
              "nullable": false,
              "kind": "bool"
            },
            "min_coverage_bps": {
              "nullable": false,
              "kind": "int"
            },
            "max_coverage_bps": {
              "nullable": false,
              "kind": "int"
            },
            "max_duration_ms": {
              "nullable": false,
              "kind": "int"
            },
            "fee_bps": {
              "nullable": false,
              "kind": "int"
            },
            "version": {
              "nullable": false,
              "kind": "int"
            },
            "updated_at": {
              "nullable": false,
              "kind": "int"
            },
            "time": {
              "nullable": false,
              "kind": "json"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            },
            "min_spot_total_liquidity": {
              "nullable": false,
              "kind": "int"
            },
            "max_coverage_fraction_of_option_bps": {
              "nullable": false,
              "kind": "int"
            },
            "max_risk_multiplier_bps": {
              "nullable": false,
              "kind": "int"
            },
            "min_premium_amount": {
              "nullable": false,
              "kind": "int"
            },
            "spot_smoothing_per_option": {
              "nullable": false,
              "kind": "int"
            },
            "implied_prob_floor_bps": {
              "nullable": false,
              "kind": "int"
            },
            "odds_floor_1x": {
              "nullable": false,
              "kind": "bool"
            },
            "odds_cap_bps": {
              "nullable": false,
              "kind": "int"
            },
            "liq_cap_bps": {
              "nullable": false,
              "kind": "int"
            },
            "liq_ref_amount": {
              "nullable": false,
              "kind": "int"
            },
            "exposure_cap_bps": {
              "nullable": false,
              "kind": "int"
            },
            "exposure_k_bps": {
              "nullable": false,
              "kind": "int"
            },
            "odds_base_bps": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      },
      "router": {
        "nullable": true,
        "kind": {
          "object": {
            "updated_by": {
              "nullable": false,
              "kind": "string"
            },
            "paused": {
              "nullable": false,
              "kind": "bool"
            },
            "max_route_reserve_market": {
              "nullable": false,
              "kind": "int"
            },
            "max_route_reserve_user": {
              "nullable": false,
              "kind": "int"
            },
            "max_route_reserve_option": {
              "nullable": false,
              "kind": "int"
            },
            "max_vault_concentration_bps": {
              "nullable": false,
              "kind": "int"
            },
            "min_vault_health_factor_bps": {
              "nullable": false,
              "kind": "int"
            },
            "max_route_legs": {
              "nullable": false,
              "kind": "int"
            },
            "version": {
              "nullable": false,
              "kind": "int"
            },
            "updated_at": {
              "nullable": false,
              "kind": "int"
            },
            "time": {
              "nullable": false,
              "kind": "json"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      }
    }
  },
  "social_list_insurance_vaults": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "vault_id": {
        "nullable": false,
        "kind": "string"
      },
      "underwriter": {
        "nullable": false,
        "kind": "string"
      },
      "capital_balance": {
        "nullable": false,
        "kind": "int"
      },
      "reserved": {
        "nullable": false,
        "kind": "int"
      },
      "base_rate_bps_per_day": {
        "nullable": false,
        "kind": "int"
      },
      "utilization_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_market": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_user": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_option": {
        "nullable": false,
        "kind": "int"
      },
      "enabled": {
        "nullable": false,
        "kind": "bool"
      },
      "paused": {
        "nullable": false,
        "kind": "bool"
      },
      "version": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_get_insurance_vault": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "vault_id": {
        "nullable": false,
        "kind": "string"
      },
      "underwriter": {
        "nullable": false,
        "kind": "string"
      },
      "capital_balance": {
        "nullable": false,
        "kind": "int"
      },
      "reserved": {
        "nullable": false,
        "kind": "int"
      },
      "base_rate_bps_per_day": {
        "nullable": false,
        "kind": "int"
      },
      "utilization_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_market": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_user": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_option": {
        "nullable": false,
        "kind": "int"
      },
      "enabled": {
        "nullable": false,
        "kind": "bool"
      },
      "paused": {
        "nullable": false,
        "kind": "bool"
      },
      "version": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_list_insurance_vault_transactions": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "vault_id": {
        "nullable": false,
        "kind": "string"
      },
      "underwriter": {
        "nullable": false,
        "kind": "string"
      },
      "capital_balance": {
        "nullable": false,
        "kind": "int"
      },
      "reserved": {
        "nullable": false,
        "kind": "int"
      },
      "base_rate_bps_per_day": {
        "nullable": false,
        "kind": "int"
      },
      "utilization_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_market": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_user": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_option": {
        "nullable": false,
        "kind": "int"
      },
      "enabled": {
        "nullable": false,
        "kind": "bool"
      },
      "paused": {
        "nullable": false,
        "kind": "bool"
      },
      "version": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_list_insurance_vault_exposures": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "vault_id": {
        "nullable": false,
        "kind": "string"
      },
      "underwriter": {
        "nullable": false,
        "kind": "string"
      },
      "capital_balance": {
        "nullable": false,
        "kind": "int"
      },
      "reserved": {
        "nullable": false,
        "kind": "int"
      },
      "base_rate_bps_per_day": {
        "nullable": false,
        "kind": "int"
      },
      "utilization_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_market": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_user": {
        "nullable": false,
        "kind": "int"
      },
      "max_exposure_per_option": {
        "nullable": false,
        "kind": "int"
      },
      "enabled": {
        "nullable": false,
        "kind": "bool"
      },
      "paused": {
        "nullable": false,
        "kind": "bool"
      },
      "version": {
        "nullable": false,
        "kind": "int"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "updated_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "transaction_id": {
        "nullable": false,
        "kind": "string"
      }
    }
  },
  "social_list_insurance_policies": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "policy_id": {
        "nullable": false,
        "kind": "string"
      },
      "market_id": {
        "nullable": false,
        "kind": "string"
      },
      "insured": {
        "nullable": false,
        "kind": "string"
      },
      "option_id": {
        "nullable": false,
        "kind": "int"
      },
      "covered_amount": {
        "nullable": false,
        "kind": "int"
      },
      "coverage_bps": {
        "nullable": false,
        "kind": "int"
      },
      "premium_paid": {
        "nullable": false,
        "kind": "int"
      },
      "premium_raw": {
        "nullable": false,
        "kind": "int"
      },
      "implied_probability_bps": {
        "nullable": false,
        "kind": "int"
      },
      "risk_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "base_premium": {
        "nullable": false,
        "kind": "int"
      },
      "market_total_amount": {
        "nullable": false,
        "kind": "int"
      },
      "option_escrow_amount": {
        "nullable": false,
        "kind": "int"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "route_id": {
        "nullable": true,
        "kind": "string"
      },
      "route_leg_index": {
        "nullable": true,
        "kind": "int"
      },
      "backstop_sweep_amount": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_get_insurance_policy": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "policy_id": {
        "nullable": false,
        "kind": "string"
      },
      "market_id": {
        "nullable": false,
        "kind": "string"
      },
      "insured": {
        "nullable": false,
        "kind": "string"
      },
      "option_id": {
        "nullable": false,
        "kind": "int"
      },
      "covered_amount": {
        "nullable": false,
        "kind": "int"
      },
      "coverage_bps": {
        "nullable": false,
        "kind": "int"
      },
      "premium_paid": {
        "nullable": false,
        "kind": "int"
      },
      "premium_raw": {
        "nullable": false,
        "kind": "int"
      },
      "implied_probability_bps": {
        "nullable": false,
        "kind": "int"
      },
      "risk_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "base_premium": {
        "nullable": false,
        "kind": "int"
      },
      "market_total_amount": {
        "nullable": false,
        "kind": "int"
      },
      "option_escrow_amount": {
        "nullable": false,
        "kind": "int"
      },
      "start_time_ms": {
        "nullable": false,
        "kind": "int"
      },
      "expiry_time_ms": {
        "nullable": false,
        "kind": "int"
      },
      "vault_id": {
        "nullable": false,
        "kind": "string"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "route_id": {
        "nullable": true,
        "kind": "string"
      },
      "route_leg_index": {
        "nullable": true,
        "kind": "int"
      },
      "backstop_sweep_amount": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_insurance_market_policies": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "policy_id": {
        "nullable": false,
        "kind": "string"
      },
      "market_id": {
        "nullable": false,
        "kind": "string"
      },
      "insured": {
        "nullable": false,
        "kind": "string"
      },
      "option_id": {
        "nullable": false,
        "kind": "int"
      },
      "covered_amount": {
        "nullable": false,
        "kind": "int"
      },
      "coverage_bps": {
        "nullable": false,
        "kind": "int"
      },
      "premium_paid": {
        "nullable": false,
        "kind": "int"
      },
      "premium_raw": {
        "nullable": false,
        "kind": "int"
      },
      "implied_probability_bps": {
        "nullable": false,
        "kind": "int"
      },
      "risk_multiplier_bps": {
        "nullable": false,
        "kind": "int"
      },
      "base_premium": {
        "nullable": false,
        "kind": "int"
      },
      "market_total_amount": {
        "nullable": false,
        "kind": "int"
      },
      "option_escrow_amount": {
        "nullable": false,
        "kind": "int"
      },
      "status": {
        "nullable": false,
        "kind": "int"
      },
      "route_id": {
        "nullable": true,
        "kind": "string"
      },
      "route_leg_index": {
        "nullable": true,
        "kind": "int"
      },
      "backstop_sweep_amount": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_vesting_wallets": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "wallets": {
        "nullable": false,
        "kind": {
          "array": {
            "wallet": {
              "nullable": false,
              "kind": {
                "object": {
                  "claimed_percentage": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "is_fully_claimed": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_started": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_ended": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "vesting_progress": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "end_time": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "claimable_amount": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "wallet": {
                    "nullable": false,
                    "kind": {
                      "object": {
                        "wallet_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "owner_address": {
                          "nullable": false,
                          "kind": "address"
                        },
                        "coin_type": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "start_time": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "schedule_end": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "pieces": {
                          "nullable": false,
                          "kind": {
                            "array": {
                              "kind": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "time_offset": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "duration": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "amount_bps": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "curve_factor": {
                                "nullable": false,
                                "kind": "int"
                              }
                            }
                          }
                        },
                        "claimed_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "remaining_balance": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "created_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "updated_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "transaction_id": {
                          "nullable": false,
                          "kind": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "user": {
              "nullable": false,
              "kind": {
                "object": {
                  "owner_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "wallet_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "username": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "fullname": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "profile_photo": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "social_proof_token": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "token_address": {
                          "nullable": true,
                          "kind": "address"
                        },
                        "is_active": {
                          "nullable": false,
                          "kind": "bool"
                        },
                        "reservation_pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "reservation_percentage": {
                          "nullable": false,
                          "kind": "float"
                        },
                        "reservation_status": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_reserved": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "required_threshold": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  },
                  "selected_badge": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "badge_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_name": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_icon_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "badge_media_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "platform_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_type": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "total": {
        "nullable": false,
        "kind": "int"
      },
      "pagination": {
        "nullable": false,
        "kind": {
          "object": {
            "total": {
              "nullable": false,
              "kind": "int"
            },
            "limit": {
              "nullable": false,
              "kind": "int"
            },
            "offset": {
              "nullable": false,
              "kind": "int"
            },
            "page": {
              "nullable": false,
              "kind": "int"
            },
            "total_pages": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_list_active_vesting_wallets": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "wallets": {
        "nullable": false,
        "kind": {
          "array": {
            "wallet": {
              "nullable": false,
              "kind": {
                "object": {
                  "claimed_percentage": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "is_fully_claimed": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_started": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_ended": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "vesting_progress": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "end_time": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "claimable_amount": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "wallet": {
                    "nullable": false,
                    "kind": {
                      "object": {
                        "wallet_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "owner_address": {
                          "nullable": false,
                          "kind": "address"
                        },
                        "coin_type": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "start_time": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "schedule_end": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "pieces": {
                          "nullable": false,
                          "kind": {
                            "array": {
                              "kind": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "time_offset": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "duration": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "amount_bps": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "curve_factor": {
                                "nullable": false,
                                "kind": "int"
                              }
                            }
                          }
                        },
                        "claimed_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "remaining_balance": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "created_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "updated_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "transaction_id": {
                          "nullable": false,
                          "kind": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "user": {
              "nullable": false,
              "kind": {
                "object": {
                  "owner_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "wallet_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "username": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "fullname": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "profile_photo": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "social_proof_token": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "token_address": {
                          "nullable": true,
                          "kind": "address"
                        },
                        "is_active": {
                          "nullable": false,
                          "kind": "bool"
                        },
                        "reservation_pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "reservation_percentage": {
                          "nullable": false,
                          "kind": "float"
                        },
                        "reservation_status": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_reserved": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "required_threshold": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  },
                  "selected_badge": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "badge_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_name": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_icon_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "badge_media_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "platform_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_type": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "total": {
        "nullable": false,
        "kind": "int"
      },
      "pagination": {
        "nullable": false,
        "kind": {
          "object": {
            "total": {
              "nullable": false,
              "kind": "int"
            },
            "limit": {
              "nullable": false,
              "kind": "int"
            },
            "offset": {
              "nullable": false,
              "kind": "int"
            },
            "page": {
              "nullable": false,
              "kind": "int"
            },
            "total_pages": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_get_vesting_wallet": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "claimed_percentage": {
        "nullable": false,
        "kind": "float"
      },
      "is_fully_claimed": {
        "nullable": false,
        "kind": "bool"
      },
      "has_started": {
        "nullable": false,
        "kind": "bool"
      },
      "has_ended": {
        "nullable": false,
        "kind": "bool"
      },
      "vesting_progress": {
        "nullable": false,
        "kind": "float"
      },
      "end_time": {
        "nullable": false,
        "kind": "int"
      },
      "claimable_amount": {
        "nullable": false,
        "kind": "int"
      },
      "wallet": {
        "nullable": false,
        "kind": {
          "object": {
            "wallet_id": {
              "nullable": false,
              "kind": "string"
            },
            "owner_address": {
              "nullable": false,
              "kind": "address"
            },
            "coin_type": {
              "nullable": false,
              "kind": "string"
            },
            "total_amount": {
              "nullable": false,
              "kind": "int"
            },
            "start_time": {
              "nullable": false,
              "kind": "int"
            },
            "schedule_end": {
              "nullable": false,
              "kind": "int"
            },
            "pieces": {
              "nullable": false,
              "kind": {
                "array": {
                  "kind": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "time_offset": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "duration": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "amount_bps": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "curve_factor": {
                    "nullable": false,
                    "kind": "int"
                  }
                }
              }
            },
            "claimed_amount": {
              "nullable": false,
              "kind": "int"
            },
            "remaining_balance": {
              "nullable": false,
              "kind": "int"
            },
            "created_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "updated_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      }
    }
  },
  "social_list_vesting_wallet_events": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "claimed_percentage": {
        "nullable": false,
        "kind": "float"
      },
      "is_fully_claimed": {
        "nullable": false,
        "kind": "bool"
      },
      "has_started": {
        "nullable": false,
        "kind": "bool"
      },
      "has_ended": {
        "nullable": false,
        "kind": "bool"
      },
      "vesting_progress": {
        "nullable": false,
        "kind": "float"
      },
      "end_time": {
        "nullable": false,
        "kind": "int"
      },
      "claimable_amount": {
        "nullable": false,
        "kind": "int"
      },
      "wallet": {
        "nullable": false,
        "kind": {
          "object": {
            "wallet_id": {
              "nullable": false,
              "kind": "string"
            },
            "owner_address": {
              "nullable": false,
              "kind": "address"
            },
            "coin_type": {
              "nullable": false,
              "kind": "string"
            },
            "total_amount": {
              "nullable": false,
              "kind": "int"
            },
            "start_time": {
              "nullable": false,
              "kind": "int"
            },
            "schedule_end": {
              "nullable": false,
              "kind": "int"
            },
            "pieces": {
              "nullable": false,
              "kind": {
                "array": {
                  "kind": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "time_offset": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "duration": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "amount_bps": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "curve_factor": {
                    "nullable": false,
                    "kind": "int"
                  }
                }
              }
            },
            "claimed_amount": {
              "nullable": false,
              "kind": "int"
            },
            "remaining_balance": {
              "nullable": false,
              "kind": "int"
            },
            "created_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "updated_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      }
    }
  },
  "social_get_vesting_claimable": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "claimed_percentage": {
        "nullable": false,
        "kind": "float"
      },
      "is_fully_claimed": {
        "nullable": false,
        "kind": "bool"
      },
      "has_started": {
        "nullable": false,
        "kind": "bool"
      },
      "has_ended": {
        "nullable": false,
        "kind": "bool"
      },
      "vesting_progress": {
        "nullable": false,
        "kind": "float"
      },
      "end_time": {
        "nullable": false,
        "kind": "int"
      },
      "claimable_amount": {
        "nullable": false,
        "kind": "int"
      },
      "wallet": {
        "nullable": false,
        "kind": {
          "object": {
            "wallet_id": {
              "nullable": false,
              "kind": "string"
            },
            "owner_address": {
              "nullable": false,
              "kind": "address"
            },
            "coin_type": {
              "nullable": false,
              "kind": "string"
            },
            "total_amount": {
              "nullable": false,
              "kind": "int"
            },
            "start_time": {
              "nullable": false,
              "kind": "int"
            },
            "schedule_end": {
              "nullable": false,
              "kind": "int"
            },
            "pieces": {
              "nullable": false,
              "kind": {
                "array": {
                  "kind": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "time_offset": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "duration": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "amount_bps": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "curve_factor": {
                    "nullable": false,
                    "kind": "int"
                  }
                }
              }
            },
            "claimed_amount": {
              "nullable": false,
              "kind": "int"
            },
            "remaining_balance": {
              "nullable": false,
              "kind": "int"
            },
            "created_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "updated_at": {
              "nullable": false,
              "kind": "timestamp"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      }
    }
  },
  "social_list_user_vesting_wallets": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "wallets": {
        "nullable": false,
        "kind": {
          "array": {
            "wallet": {
              "nullable": false,
              "kind": {
                "object": {
                  "claimed_percentage": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "is_fully_claimed": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_started": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "has_ended": {
                    "nullable": false,
                    "kind": "bool"
                  },
                  "vesting_progress": {
                    "nullable": false,
                    "kind": "float"
                  },
                  "end_time": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "claimable_amount": {
                    "nullable": false,
                    "kind": "int"
                  },
                  "wallet": {
                    "nullable": false,
                    "kind": {
                      "object": {
                        "wallet_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "owner_address": {
                          "nullable": false,
                          "kind": "address"
                        },
                        "coin_type": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "start_time": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "schedule_end": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "pieces": {
                          "nullable": false,
                          "kind": {
                            "array": {
                              "kind": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "time_offset": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "duration": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "amount_bps": {
                                "nullable": false,
                                "kind": "int"
                              },
                              "curve_factor": {
                                "nullable": false,
                                "kind": "int"
                              }
                            }
                          }
                        },
                        "claimed_amount": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "remaining_balance": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "created_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "updated_at": {
                          "nullable": false,
                          "kind": "timestamp"
                        },
                        "transaction_id": {
                          "nullable": false,
                          "kind": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "user": {
              "nullable": false,
              "kind": {
                "object": {
                  "owner_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "wallet_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "username": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "fullname": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "profile_photo": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "social_proof_token": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "token_address": {
                          "nullable": true,
                          "kind": "address"
                        },
                        "is_active": {
                          "nullable": false,
                          "kind": "bool"
                        },
                        "reservation_pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "reservation_percentage": {
                          "nullable": false,
                          "kind": "float"
                        },
                        "reservation_status": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_reserved": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "required_threshold": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  },
                  "selected_badge": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "badge_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_name": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_icon_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "badge_media_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "platform_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_type": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "total": {
        "nullable": false,
        "kind": "int"
      },
      "pagination": {
        "nullable": false,
        "kind": {
          "object": {
            "total": {
              "nullable": false,
              "kind": "int"
            },
            "limit": {
              "nullable": false,
              "kind": "int"
            },
            "offset": {
              "nullable": false,
              "kind": "int"
            },
            "page": {
              "nullable": false,
              "kind": "int"
            },
            "total_pages": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_list_vesting_events": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "events": {
        "nullable": false,
        "kind": {
          "array": {
            "id": {
              "nullable": false,
              "kind": "int"
            },
            "wallet_id": {
              "nullable": false,
              "kind": "string"
            },
            "event_type": {
              "nullable": false,
              "kind": "string"
            },
            "owner_address": {
              "nullable": false,
              "kind": "address"
            },
            "coin_type": {
              "nullable": false,
              "kind": "string"
            },
            "amount": {
              "nullable": false,
              "kind": "int"
            },
            "remaining_balance": {
              "nullable": true,
              "kind": "int"
            },
            "start_time": {
              "nullable": true,
              "kind": "int"
            },
            "schedule_end": {
              "nullable": true,
              "kind": "int"
            },
            "pieces": {
              "nullable": true,
              "kind": "json"
            },
            "event_time": {
              "nullable": false,
              "kind": "int"
            },
            "time": {
              "nullable": false,
              "kind": "json"
            },
            "transaction_id": {
              "nullable": false,
              "kind": "string"
            }
          }
        }
      },
      "total": {
        "nullable": false,
        "kind": "int"
      },
      "pagination": {
        "nullable": false,
        "kind": {
          "object": {
            "total": {
              "nullable": false,
              "kind": "int"
            },
            "limit": {
              "nullable": false,
              "kind": "int"
            },
            "offset": {
              "nullable": false,
              "kind": "int"
            },
            "page": {
              "nullable": false,
              "kind": "int"
            },
            "total_pages": {
              "nullable": false,
              "kind": "int"
            }
          }
        }
      }
    }
  },
  "social_get_vesting_analytics": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "coin_type": {
        "nullable": true,
        "kind": "string"
      },
      "total_wallets": {
        "nullable": false,
        "kind": "int"
      },
      "total_vested_amount": {
        "nullable": false,
        "kind": "int"
      },
      "total_claimed_amount": {
        "nullable": false,
        "kind": "int"
      },
      "total_remaining_amount": {
        "nullable": false,
        "kind": "int"
      },
      "active_wallets": {
        "nullable": false,
        "kind": "int"
      },
      "completed_wallets": {
        "nullable": false,
        "kind": "int"
      },
      "average_schedule_duration": {
        "nullable": false,
        "kind": "float"
      }
    }
  },
  "social_get_vesting_leaderboard": {
    "list": false,
    "scope": "social:read",
    "fields": {
      "entries": {
        "nullable": false,
        "kind": {
          "array": {
            "owner_address": {
              "nullable": false,
              "kind": "address"
            },
            "coin_type": {
              "nullable": false,
              "kind": "string"
            },
            "total_vested": {
              "nullable": false,
              "kind": "int"
            },
            "total_claimed": {
              "nullable": false,
              "kind": "int"
            },
            "active_wallets": {
              "nullable": false,
              "kind": "int"
            },
            "completed_wallets": {
              "nullable": false,
              "kind": "int"
            },
            "user": {
              "nullable": false,
              "kind": {
                "object": {
                  "owner_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "wallet_address": {
                    "nullable": false,
                    "kind": "address"
                  },
                  "username": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "fullname": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "profile_photo": {
                    "nullable": true,
                    "kind": "string"
                  },
                  "social_proof_token": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "token_address": {
                          "nullable": true,
                          "kind": "address"
                        },
                        "is_active": {
                          "nullable": false,
                          "kind": "bool"
                        },
                        "reservation_pool_id": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "reservation_percentage": {
                          "nullable": false,
                          "kind": "float"
                        },
                        "reservation_status": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "total_reserved": {
                          "nullable": false,
                          "kind": "int"
                        },
                        "required_threshold": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  },
                  "selected_badge": {
                    "nullable": true,
                    "kind": {
                      "object": {
                        "badge_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_name": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_icon_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "badge_media_url": {
                          "nullable": true,
                          "kind": "string"
                        },
                        "platform_id": {
                          "nullable": false,
                          "kind": "string"
                        },
                        "badge_type": {
                          "nullable": false,
                          "kind": "int"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "total": {
        "nullable": false,
        "kind": "int"
      }
    }
  },
  "social_list_platform_moderators": {
    "list": true,
    "scope": "social:read",
    "fields": {
      "moderator_address": {
        "nullable": false,
        "kind": "address"
      },
      "added_by": {
        "nullable": false,
        "kind": "string"
      },
      "created_at": {
        "nullable": false,
        "kind": "timestamp"
      },
      "permissions": {
        "nullable": false,
        "kind": "strings"
      }
    }
  },
  "social_list_platform_events": {
    "list": false,
    "scope": "social:read",
    "value": true,
    "keys": [
      "events",
      "total"
    ]
  }
} as const;
