"""core/models.py — Modèles Pydantic v2 pour ADBI CV Parser."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, EmailStr, Field, field_validator


# ══════════════════════════════════════════════════════════════════════════════
# ÉNUMÉRATIONS
# ══════════════════════════════════════════════════════════════════════════════

class UserRole(str, Enum):
    user       = "user"
    superuser  = "superuser"


class SeniorityLevel(str, Enum):
    junior     = "junior"       # 0-2 ans
    confirme   = "confirmé"     # 3-5 ans
    senior     = "senior"       # 6-9 ans
    expert     = "expert"       # 10+ ans


class AvailabilityStatus(str, Enum):
    disponible   = "disponible"
    trente_jours = "30 jours"
    soixante_j   = "60 jours"
    non_dispo    = "non disponible"
    inconnue     = "inconnue"


class ContractType(str, Enum):
    cdi        = "CDI"
    cdd        = "CDD"
    freelance  = "Freelance"
    stage      = "Stage"
    alternance = "Alternance"
    tous       = "Tous"


class NeedStatus(str, Enum):
    active   = "active"
    archive  = "archivé"
    pourvu   = "pourvu"


# ══════════════════════════════════════════════════════════════════════════════
# AUTH
# ══════════════════════════════════════════════════════════════════════════════

class UserCreate(BaseModel):
    email:     str
    password:  str = Field(min_length=6)
    role:      UserRole = UserRole.user
    full_name: str = ""


class UserLogin(BaseModel):
    email:    str
    password: str


class UserUpdate(BaseModel):
    full_name:  Optional[str]  = None
    role:       Optional[UserRole] = None
    is_active:  Optional[bool] = None
    password:   Optional[str]  = None


class TokenResponse(BaseModel):
    access_token:  str
    token_type:    str = "bearer"
    expires_in:    int       # secondes
    user:          dict


# ══════════════════════════════════════════════════════════════════════════════
# BESOIN CLIENT (Need)
# ══════════════════════════════════════════════════════════════════════════════

class NeedCreate(BaseModel):
    title:              str   = Field(min_length=2, description="Intitulé de la mission")
    context:            str   = ""
    required_skills:    list[str] = Field(default_factory=list)
    bonus_skills:       list[str] = Field(default_factory=list)
    seniority:          Optional[str] = None
    min_years:          int   = Field(default=0, ge=0)
    languages:          list[str] = Field(default_factory=list)
    location:           str   = ""
    remote:             str   = "flexible"   # flexible / full_remote / on_site
    start_date:         str   = ""
    contract_type:      str   = ContractType.tous.value
    budget:             str   = ""
    client:             str   = ""
    sector:             str   = ""
    notes:              str   = ""
    raw_text:           str   = ""           # texte libre saisi
    prix_achat:         float = 0.0          # €/jour — coût d'achat
    prix_vente:         float = 0.0          # €/jour — prix de vente

    @field_validator("required_skills", "bonus_skills", "languages", mode="before")
    @classmethod
    def split_if_str(cls, v):
        if isinstance(v, str):
            return [x.strip() for x in v.replace(";", ",").split(",") if x.strip()]
        return v or []


class NeedUpdate(NeedCreate):
    title:           Optional[str] = None
    status:          Optional[NeedStatus] = None


class NeedOut(NeedCreate):
    id:         str
    status:     NeedStatus = NeedStatus.active
    created_by: str
    created_at: str
    updated_at: str


# ══════════════════════════════════════════════════════════════════════════════
# MATCHING
# ══════════════════════════════════════════════════════════════════════════════

class MatchScore(BaseModel):
    total:        float = 0.0   # /100
    skills:       float = 0.0   # /35
    title:        float = 0.0   # /20
    seniority:    float = 0.0   # /15
    availability: float = 0.0   # /10
    missions:     float = 0.0   # /10
    bonus:        float = 0.0   # /10


class MatchExplanation(BaseModel):
    strengths:       list[str] = Field(default_factory=list)
    weaknesses:      list[str] = Field(default_factory=list)
    reservations:    list[str] = Field(default_factory=list)
    missing_skills:  list[str] = Field(default_factory=list)
    summary:         str = ""


class MatchResult(BaseModel):
    candidate_id:   str
    candidate_name: str
    candidate_title: str
    score:          MatchScore
    explanation:    MatchExplanation
    rank:           int = 0
    # Infos contact pour affichage direct
    email:          str = ""
    phone:          str = ""
    location:       str = ""
    availability:   str = ""
    top_skills:     list[str] = Field(default_factory=list)
